-- 模組 10(會員與紅利)— 對應規格書 §3.9~§3.14、§3.17~§3.18、規則 2.5~2.7、2.9。
-- 涵蓋:redeem_member_points(規則 2.7)、adjust_member_points(規則 2.6 核心,僅限管理員)、
-- grant_pending_birthday_bonuses(規則 2.5)、get_member_point_history/get_member_related_bookings/
-- get_member_referrals(唯讀函式 + 一之二節方向二權限邊界)、platform_export/purge(規則 2.9)。
begin;

select plan(35);

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
  ('ec000000-0000-4000-8000-000000000001', 'pgtap-m10c-admin-a@test.local'),
  ('ec000000-0000-4000-8000-000000000002', 'pgtap-m10c-platform-admin@test.local'),
  ('ec000000-0000-4000-8000-000000000003', 'pgtap-m10c-agent-members@test.local'),
  ('ec000000-0000-4000-8000-000000000004', 'pgtap-m10c-agent-orders@test.local');

insert into groups (id) values ('ec000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000011', '會員紅利測試C店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000001');

insert into platform_admins (user_id) values ('ec000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('ec000000-0000-4000-8000-000000000051', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000003', '客服-members', 'pgtap-m10c-agent-members@test.local', 'active', now()),
  ('ec000000-0000-4000-8000-000000000052', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000004', '客服-僅訂單', 'pgtap-m10c-agent-orders@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ec000000-0000-4000-8000-000000000051', 'members', true),
  ('ec000000-0000-4000-8000-000000000052', 'orders', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'ec000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('ec000000-0000-4000-8000-000000000031', 'ec000000-0000-4000-8000-000000000021', '洗髮', 500, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('ec000000-0000-4000-8000-000000000041', 'ec000000-0000-4000-8000-000000000021', '服務人員P', null, true, 'piece_rate');

insert into merchant_member_settings (merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points)
values ('ec000000-0000-4000-8000-000000000021', 100, 0, 88);

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select id from create_member('ec000000-0000-4000-8000-000000000021', '點數測試會員', '0988000001') \gset member_
select pg_temp.test_clear_auth();

-- 讓 member_ 先有 200 點可以測兌換/調整(直接呼叫 redeem 的對照組先用 adjust 灌一筆)。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select adjust_member_points(:'member_id'::uuid, 200, '測試灌點');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ① 規則 2.7:redeem_member_points 不能讓餘額變負。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select throws_ok(
  format($$select redeem_member_points('%s', 300, '超額兌換測試')$$, (:'member_id')),
  'P0001', null,
  '規則 2.7:兌換點數超過餘額被擋下'
);

select redeem_member_points(:'member_id'::uuid, 200, '剛好兌換全部');

select is(
  (select points_balance from members where id = :'member_id'::uuid),
  0,
  '規則 2.7:剛好等於餘額可以兌換成 0'
);

select is(
  (select count(*)::int from member_point_transactions where member_id = :'member_id'::uuid and transaction_type = 'redeem'),
  1,
  '3.9:redeem_member_points 正確寫入一筆 redeem 分類帳'
);

select throws_ok(
  format($$select redeem_member_points('%s', 10, null)$$, (:'member_id')),
  'P0001', null,
  '3.9:redeem_member_points 沒有填 note 被擋下'
);

select throws_ok(
  format($$select redeem_member_points('%s', 0, '零點測試')$$, (:'member_id')),
  'P0001', null,
  '3.9:redeem_member_points 點數必須 > 0'
);

-- =========================================================================
-- ② 規則 2.6(核心必測):手動調整點數僅限商家管理員。
-- =========================================================================
select adjust_member_points(:'member_id'::uuid, 50, '重新灌點供後續測試');

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000003');

select throws_ok(
  format($$select adjust_member_points('%s', 10, '客服嘗試調整')$$, (:'member_id')),
  '42501', null,
  '規則 2.6(核心):被授權 members 的客服呼叫 adjust_member_points 被擋下'
);

-- 對照組:同一位被授權 members 的客服呼叫 redeem_member_points 可以成功。
select lives_ok(
  format($$select redeem_member_points('%s', 5, '客服兌換測試')$$, (:'member_id')),
  '規則 2.6 對照組:同一位被授權 members 的客服呼叫 redeem_member_points 可以成功(只有手動調整這一支特別鎖死)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select lives_ok(
  format($$select adjust_member_points('%s', 10, '管理員調整測試')$$, (:'member_id')),
  '規則 2.6:商家管理員呼叫 adjust_member_points 成功'
);

-- 規則 2.7:adjust_member_points 不允許調整後餘額變負。
select throws_ok(
  format($$select adjust_member_points('%s', -99999, '調整成負數測試')$$, (:'member_id')),
  'P0001', null,
  '規則 2.7:adjust_member_points 不允許調整後餘額變成負數'
);

select throws_ok(
  format($$select adjust_member_points('%s', 0, '零調整測試')$$, (:'member_id')),
  'P0001', null,
  '3.10:adjust_member_points 調整點數不可為 0'
);

select throws_ok(
  format($$select adjust_member_points('%s', 10, null)$$, (:'member_id')),
  'P0001', null,
  '3.10:adjust_member_points 沒有填 note 被擋下'
);

-- =========================================================================
-- ③ 規則 2.5:grant_pending_birthday_bonuses(本月生日容錯、防重複核發)。
-- =========================================================================
select id from create_member('ec000000-0000-4000-8000-000000000021', '本月生日會員', '0988000002', p_birthday => (date_trunc('month', current_date) + interval '2 days')::date) \gset birthday_member_
select id from create_member('ec000000-0000-4000-8000-000000000021', '非本月生日會員', '0988000003', p_birthday => (date_trunc('month', current_date) - interval '2 months')::date) \gset non_birthday_member_
select id from create_member('ec000000-0000-4000-8000-000000000021', '沒填生日會員', '0988000004') \gset no_birthday_member_

select grant_pending_birthday_bonuses('ec000000-0000-4000-8000-000000000021') \gset birthday_run1_

select is(
  (select points_balance from members where id = :'birthday_member_id'::uuid),
  88,
  '規則 2.5:本月生日且今年未核發的會員正確核發 88 點'
);

select is(
  (select last_birthday_bonus_year from members where id = :'birthday_member_id'::uuid),
  extract(year from current_date)::int,
  '規則 2.5:核發後正確標記今年的年份'
);

select is(
  (select points_balance from members where id = :'non_birthday_member_id'::uuid),
  0,
  '規則 2.5:非本月生日的會員不受影響'
);

select is(
  (select last_birthday_bonus_year from members where id = :'non_birthday_member_id'::uuid),
  null,
  '規則 2.5:非本月生日的會員 last_birthday_bonus_year 不會被標記'
);

select is(
  (select points_balance from members where id = :'no_birthday_member_id'::uuid),
  0,
  '規則 2.5 邊界情況:birthday 為 null 的會員永遠不會被選中,不會報錯'
);

-- 已核發過的今年不重複(重複呼叫應該冪等)。
select grant_pending_birthday_bonuses('ec000000-0000-4000-8000-000000000021') \gset birthday_run2_

select is(
  (select points_balance from members where id = :'birthday_member_id'::uuid),
  88,
  '規則 2.5:已核發過的今年不重複呼叫,餘額維持 88 點'
);

-- birthday_bonus_points=0 時仍正確標記年份。
update merchant_member_settings set birthday_bonus_points = 0
where merchant_id = 'ec000000-0000-4000-8000-000000000021';

select id from create_member('ec000000-0000-4000-8000-000000000021', '零生日獎勵會員', '0988000005', p_birthday => (date_trunc('month', current_date) + interval '5 days')::date) \gset zero_birthday_member_

select grant_pending_birthday_bonuses('ec000000-0000-4000-8000-000000000021') \gset birthday_run3_

select is(
  (select points_balance from members where id = :'zero_birthday_member_id'::uuid),
  0,
  '規則 2.5:birthday_bonus_points=0 時,餘額不變'
);

select isnt(
  (select last_birthday_bonus_year from members where id = :'zero_birthday_member_id'::uuid),
  null,
  '規則 2.5:birthday_bonus_points=0 時,仍正確標記 last_birthday_bonus_year'
);

select pg_temp.test_clear_auth();

-- 規則 2.10:未被開通 members 的客服(僅 orders)呼叫 grant_pending_birthday_bonuses 被擋下。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004');
select throws_ok(
  $$select grant_pending_birthday_bonuses('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '規則 2.10:僅有 orders 權限的客服呼叫 grant_pending_birthday_bonuses 被擋下'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ §3.12~§3.14:唯讀函式正確性 + 一之二節方向二權限邊界。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'ec000000-0000-4000-8000-000000000021',
  p_staff_id => 'ec000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ec000000-0000-4000-8000-000000000031','quantity',1,'unit_price',500)),
  p_start_at => '2026-12-10 10:00:00+08',
  p_customer_name => '讀取函式測試客戶',
  p_customer_phone => '0955040001',
  p_custom_total_amount_enabled => true,
  p_custom_total_amount => 1000,
  p_member_id => :'birthday_member_id'::uuid
) \gset read_test_booking_

select confirm_booking(:'read_test_booking_id'::uuid);
select complete_booking(:'read_test_booking_id'::uuid);

select is(
  (select count(*)::int from get_member_point_history(:'birthday_member_id'::uuid)),
  2,
  '3.12:get_member_point_history 回傳正確筆數(生日贈點 + 這筆消費核發)'
);

select is(
  (select count(*)::int from get_member_related_bookings(:'birthday_member_id'::uuid)),
  1,
  '3.13:get_member_related_bookings 正確回傳這位會員的訂單'
);

select id from create_member('ec000000-0000-4000-8000-000000000021', '推薦名單測試會員', '0988000006', p_referred_by_member_id => :'birthday_member_id'::uuid) \gset referral_list_member_

select is(
  (select count(*)::int from get_member_referrals(:'birthday_member_id'::uuid)),
  1,
  '3.14:get_member_referrals 正確回傳這位會員推薦過的人'
);

select pg_temp.test_clear_auth();

-- 一之二節方向二:只有 orders 權限、沒有 members 權限的客服呼叫 get_member_related_bookings 被擋下
-- (驗證確實走的是 can_manage_members,不是 can_manage_bookings)。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004');
select throws_ok(
  format($$select * from get_member_related_bookings('%s')$$, (:'birthday_member_id')),
  '42501', null,
  '一之二節方向二:只有 orders 權限、沒有 members 權限的客服呼叫 get_member_related_bookings 被擋下'
);

select throws_ok(
  format($$select * from get_member_point_history('%s')$$, (:'birthday_member_id')),
  '42501', null,
  '3.12:只有 orders 權限、沒有 members 權限的客服呼叫 get_member_point_history 被擋下'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ 規則 2.9:危險操作判斷 + 平台掛鉤點。
-- =========================================================================
-- 平台管理員/商家管理員可以匯出;一般客服被擋下。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000002');
select lives_ok(
  $$select platform_export_merchant_members_snapshot('ec000000-0000-4000-8000-000000000021')$$,
  '3.17:平台管理員可以匯出商家會員快照'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select lives_ok(
  $$select platform_export_merchant_members_snapshot('ec000000-0000-4000-8000-000000000021')$$,
  '3.17:商家管理員自己也可以匯出'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000003');
select throws_ok(
  $$select platform_export_merchant_members_snapshot('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '3.17:一般客服(即使有 members 權限)呼叫 platform_export_merchant_members_snapshot 被擋下'
);
select pg_temp.test_clear_auth();

-- purge:只有平台管理員能執行,商家管理員/客服皆被擋下。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select throws_ok(
  $$select platform_purge_merchant_members_and_points('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '3.18:商家管理員呼叫 platform_purge_merchant_members_and_points 被擋下(這是真正不可逆的硬刪除,不開放給商家自己操作)'
);
select pg_temp.test_clear_auth();

-- 注意:bookings 表的 SELECT 政策(bookings_select)要求 can_manage_bookings(即
-- is_merchant_admin 或 orders 權限客服),平台管理員本身不滿足這個條件(is_platform_admin 是
-- 一把完全獨立的鑰匙)——這裡「訂單筆數不受影響」的驗證改用商家管理員的身分讀取,只有真正呼叫
-- platform_purge_merchant_members_and_points 那一步才切換成平台管理員身分。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select is(
  (select count(*)::int from bookings where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  1,
  '3.18 前置確認:清空前這間商家有 1 筆訂單'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000002');

select platform_purge_merchant_members_and_points('ec000000-0000-4000-8000-000000000021');

select is(
  (select count(*)::int from members where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  0,
  '3.18:執行後 members 該商家資料歸零'
);

select is(
  (select count(*)::int from member_point_transactions where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  0,
  '3.18:執行後 member_point_transactions 該商家資料歸零'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select is(
  (select count(*)::int from bookings where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  1,
  '3.18:bookings 本身筆數不受影響(訂單沒有被刪除)'
);

select is(
  (select member_id from bookings where id = :'read_test_booking_id'::uuid),
  null,
  '3.18:on delete set null 生效,bookings.member_id 正確變成 null,其餘欄位(如金額)不受影響'
);

select is(
  (select final_amount_snapshot from bookings where id = :'read_test_booking_id'::uuid),
  1000.00,
  '3.18:bookings 其餘欄位(final_amount_snapshot)完全不受清空操作影響'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
