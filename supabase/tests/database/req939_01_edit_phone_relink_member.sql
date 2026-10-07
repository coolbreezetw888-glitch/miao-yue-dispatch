-- SPECS-INDEX #939 / #988(第 11 批 A):已連結會員的訂單改電話 ⇒ 自動改掛會員 + 紅利重算
-- migration 20261007140150_b11_a_edit_phone_relink_member.sql
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §一、§5.1(16 條情境)。
--
--   T1  改成另一位會員的電話 ⇒ 改掛;姓名快照取會員資料;客戶姓名照表單;兩位會員資料一個欄位都沒變
--   T2  改成沒人用的電話 ⇒ 自動建一位(姓名 = 表單、電話 = 新電話、email 有帶);member_auto_created 不變
--   T3  只改格式 ⇒ 不算改電話(原會員資料上的電話已改過,沒有正規化比對就會誤建新會員)
--   T4  改成原會員資料上目前的電話 ⇒ 仍掛原會員、分類帳不新增
--   T5  原單有折抵 ⇒ 全數退回原會員(備註全形版)、訂單折抵歸 0
--   T6  改掛 + 對新會員折抵(帶新會員 id)⇒ 新會員被扣;還帶原會員 id ⇒ 擋下
--   T7  派點:未覆寫 ⇒ 依新會員重算;已覆寫 ⇒ 保留客服數字、只更新建議值
--   T8  沒連結會員的舊單改電話 ⇒ 不會自動連結(行為不變)
--   T9  服務人員 staff_update_booking 改電話 ⇒ 同 T1 / T2
--   T10 已完成單:完成 → 還原 → 改電話 → 再完成;原會員點數收回(不足扣到 0)、新會員拿滿
--   T11 新會員是黑名單 ⇒ 照樣改掛
--   T12 新電話只對到已下架會員 ⇒ 建一位新的 active 會員
--   T13 新電話只對到別家商家的會員 ⇒ 不會掛別家;在本店建新會員
--   T14 預覽一致性:preview_booking_points 的 resolution / member_id = update_booking 結果
--   T15 權限:沒有 orders 鑰匙 ⇒ 42501;新 helper 對 authenticated / anon / PUBLIC 都沒有 EXECUTE
--   T16 交易原子性:要求折抵失敗 ⇒ 不多出新會員、原折抵沒被退
begin;

select plan(40);

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

-- ── Fixture ──────────────────────────────────────────────────────────────────
--   01 M 店管理員 / 04 M 店客服(只有 members 鑰匙,沒有 orders)/ 05 服務人員甲(可以自己下單)
insert into auth.users (id, email) values
  ('e9390000-0000-4000-8000-000000000001', 'pgtap-r939-admin@test.local'),
  ('e9390000-0000-4000-8000-000000000004', 'pgtap-r939-agent-members@test.local'),
  ('e9390000-0000-4000-8000-000000000005', 'pgtap-r939-staff@test.local');

insert into groups (id) values
  ('e9390000-0000-4000-8000-000000000011'),
  ('e9390000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('e9390000-0000-4000-8000-000000000021', 'e9390000-0000-4000-8000-000000000011', '#939 M 店', 'in_store_beauty'),
  ('e9390000-0000-4000-8000-000000000022', 'e9390000-0000-4000-8000-000000000012', '#939 X 店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values
  ('e9390000-0000-4000-8000-000000000021', 'e9390000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('e9390000-0000-4000-8000-000000000051', 'e9390000-0000-4000-8000-000000000021',
   'e9390000-0000-4000-8000-000000000004', '客服(只有會員)', '0900939051',
   'pgtap-r939-agent-members@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e9390000-0000-4000-8000-000000000051', 'members', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e9390000-0000-4000-8000-000000000021', d, false, '00:00', '23:59' from generate_series(0, 6) as d;
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('e9390000-0000-4000-8000-000000000031', 'e9390000-0000-4000-8000-000000000021', '清洗', 1000, 'primary', 30, 'active');
insert into payment_methods (id, merchant_id, name) values
  ('e9390000-0000-4000-8000-000000000071', 'e9390000-0000-4000-8000-000000000021', '現場付款');

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at,
                            unlimited_backend_edit, phone, can_create_edit_orders, show_member_info) values
  ('e9390000-0000-4000-8000-000000000041', 'e9390000-0000-4000-8000-000000000021', 'e9390000-0000-4000-8000-000000000005',
   '服務人員甲', 'monthly_salary', 'active', 'active', now(), true, '0900939041', true, true);
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('e9390000-0000-4000-8000-000000000041', 'staff_calendar_view', true);

-- 紅利:每筆 10 點、最低 500 元;**只有綁了 LINE 的會員拿得到**(讓「換會員 ⇒ 派點跟著變」看得出來);
-- 100 點 = 10 元、單次最多 50%。
insert into merchant_member_settings (merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
                                      redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent,
                                      reward_condition_mode)
values ('e9390000-0000-4000-8000-000000000021', 'basic', 10, 500, 100, 10, 50, 'line_bound');

insert into members (id, merchant_id, name, phone, email, referral_code, points_balance, status, line_bound, line_user_id,
                     is_blacklisted, blacklist_reason) values
  -- A:綁 LINE(拿得到點)、有點數
  ('e9390000-0000-4000-8000-000000000061', 'e9390000-0000-4000-8000-000000000021', '會員甲', '0911939001', null, 'R939A001', 2000, 'active', true, 'U939a', false, null),
  -- B:沒綁 LINE(拿不到點)、有點數
  ('e9390000-0000-4000-8000-000000000062', 'e9390000-0000-4000-8000-000000000021', '會員乙', '0911939002', 'b@r939.test', 'R939A002', 300, 'active', false, null, false, null),
  -- C:綁 LINE,T10 的新會員
  ('e9390000-0000-4000-8000-000000000063', 'e9390000-0000-4000-8000-000000000021', '會員丙', '0911939003', null, 'R939A003', 0, 'active', true, 'U939c', false, null),
  -- BL:黑名單
  ('e9390000-0000-4000-8000-000000000064', 'e9390000-0000-4000-8000-000000000021', '黑名單丁', '0911939004', null, 'R939A004', 0, 'active', false, null, true, '屢次爽約'),
  -- R:已下架
  ('e9390000-0000-4000-8000-000000000065', 'e9390000-0000-4000-8000-000000000021', '已下架戊', '0911939005', null, 'R939A005', 0, 'removed', false, null, false, null),
  -- Z:0 點
  ('e9390000-0000-4000-8000-000000000066', 'e9390000-0000-4000-8000-000000000021', '零點己', '0911939006', null, 'R939A006', 0, 'active', false, null, false, null),
  -- E / F:綁 LINE,T10 的原會員(F 之後點數會被用掉)
  ('e9390000-0000-4000-8000-000000000067', 'e9390000-0000-4000-8000-000000000021', '會員庚', '0911939007', null, 'R939A007', 0, 'active', true, 'U939e', false, null),
  ('e9390000-0000-4000-8000-000000000068', 'e9390000-0000-4000-8000-000000000021', '會員辛', '0911939008', null, 'R939A008', 0, 'active', true, 'U939f', false, null),
  -- G / H:T3 / T4 用(建單後把會員資料上的電話改掉)
  ('e9390000-0000-4000-8000-000000000069', 'e9390000-0000-4000-8000-000000000021', '會員壬', '0911939009', null, 'R939A009', 500, 'active', false, null, false, null),
  ('e9390000-0000-4000-8000-000000000070', 'e9390000-0000-4000-8000-000000000021', '會員癸', '0911939010', null, 'R939A010', 500, 'active', false, null, false, null),
  -- X 店的會員
  ('e9390000-0000-4000-8000-000000000072', 'e9390000-0000-4000-8000-000000000022', '別家客人', '0911939013', null, 'R939A013', 900, 'active', false, null, false, null);

create function pg_temp.items()
returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'service_item_id', 'e9390000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', 1000));
$$;

create function pg_temp.member_by_phone(p_phone text)
returns uuid language sql security definer as $$
  select r.member_id from private.resolve_booking_member_by_phone('e9390000-0000-4000-8000-000000000021', p_phone) r
  where r.match_count = 1;
$$;

-- 建單(由電話決定會員;主要服務人員 = 服務人員甲)。
create function pg_temp.mk(p_phone text, p_day int, p_redeemed int default 0, p_override int default null)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'e9390000-0000-4000-8000-000000000021',
    p_staff_id => 'e9390000-0000-4000-8000-000000000041',
    p_service_items => pg_temp.items(),
    p_start_at => timestamptz '2036-03-01 10:00:00+08' + make_interval(days => p_day),
    p_customer_name => '原本的客人',
    p_customer_phone => p_phone,
    p_payment_method_id => 'e9390000-0000-4000-8000-000000000071',
    p_points_override => p_override,
    p_points_redeemed => p_redeemed,
    p_points_redeem_member_id => case when p_redeemed > 0 then pg_temp.member_by_phone(p_phone) end
  );
$$;

-- 改單(商家前端的呼叫方式:p_member_id 一律帶這張單目前的會員;紅利參數照帶)。
create function pg_temp.upd(p_booking uuid, p_phone text, p_name text default '表單上的姓名',
                            p_redeemed int default null, p_redeem_member uuid default null,
                            p_email text default null)
returns public.bookings language sql as $$
  select * from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'e9390000-0000-4000-8000-000000000041',
    p_service_items => pg_temp.items(),
    p_start_at => (select start_at from public.bookings where id = p_booking),
    p_customer_name => p_name,
    p_customer_phone => p_phone,
    p_customer_email => p_email,
    p_payment_method_id => 'e9390000-0000-4000-8000-000000000071',
    p_member_id => (select member_id from public.bookings where id = p_booking),
    p_points_redeemed => p_redeemed,
    p_points_redeem_member_id => p_redeem_member
  );
$$;

-- 服務人員身分讀不到 bookings 表(RLS),開始時間用 security definer 小工具讀。
create function pg_temp.start_of(p_booking uuid)
returns timestamptz language sql security definer as $$ select start_at from public.bookings where id = p_booking; $$;

-- 服務人員改單(會員由包裝函式維持現值)。
create function pg_temp.sup(p_booking uuid, p_phone text, p_name text default '服務人員改的姓名')
returns jsonb language sql as $$
  select public.staff_update_booking(
    p_booking_id => p_booking,
    p_service_items => pg_temp.items(),
    p_start_at => pg_temp.start_of(p_booking),
    p_customer_name => p_name,
    p_customer_phone => p_phone,
    p_payment_method_id => 'e9390000-0000-4000-8000-000000000071'
  );
$$;

-- 編輯模式預覽(前端照舊送這張單目前的會員 + 表單電話)。
create function pg_temp.pv(p_booking uuid, p_phone text)
returns jsonb language sql as $$
  select public.preview_booking_points(
    'e9390000-0000-4000-8000-000000000021', p_booking,
    (select member_id from public.bookings where id = p_booking),
    p_phone, pg_temp.items(), false, null, false, null, null, false, null, null);
$$;

create function pg_temp.mrow(p_member uuid)
returns text language sql as $$ select md5(row(m.*)::text) from public.members m where m.id = p_member; $$;

grant execute on function pg_temp.items(), pg_temp.member_by_phone(text), pg_temp.mk(text, int, int, int),
  pg_temp.upd(uuid, text, text, int, uuid, text), pg_temp.sup(uuid, text, text), pg_temp.pv(uuid, text), pg_temp.start_of(uuid)
  to authenticated;

-- ── 布置(管理員建單)───────────────────────────────────────────────────────
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select pg_temp.mk('0911939001', 1) as id \gset b1_
select pg_temp.mk('0911939001', 2) as id \gset b2_
select pg_temp.mk('0911939009', 3, 100) as id \gset b3_
select pg_temp.mk('0911939010', 4) as id \gset b4_
select pg_temp.mk('0911939001', 5, 300) as id \gset b5_
select pg_temp.mk('0911939001', 6) as id \gset b6_
select pg_temp.mk('0911939001', 7) as id \gset b6x_
select pg_temp.mk('0911939001', 8) as id \gset b7_
select pg_temp.mk('0911939001', 9, 0, 50) as id \gset b7o_
select pg_temp.mk('0911939001', 10) as id \gset b8_
select pg_temp.mk('0911939001', 11) as id \gset b9_
select pg_temp.mk('0911939001', 12) as id \gset b9n_
select pg_temp.mk('0911939007', 13) as id \gset b10_
select pg_temp.mk('0911939008', 14) as id \gset b10s_
select pg_temp.mk('0911939001', 15) as id \gset b11_
select pg_temp.mk('0911939001', 16) as id \gset b12_
select pg_temp.mk('0911939001', 17) as id \gset b13_
select pg_temp.mk('0911939001', 18) as id \gset b14_
select pg_temp.mk('0911939001', 19) as id \gset b14n_
select pg_temp.mk('0911939001', 20, 200) as id \gset b16_
select pg_temp.test_clear_auth();

-- T3 / T4 情境:建單之後,會員資料上的電話被改掉了(G → 0911939019、H → 0911939020)。
update members set phone = '0911939019' where id = 'e9390000-0000-4000-8000-000000000069';
update members set phone = '0911939020' where id = 'e9390000-0000-4000-8000-000000000070';
-- T8 情境:沒有連結會員的舊單(訪客單)。
update bookings set member_id = null, member_name_snapshot = null where id = :'b8_id'::uuid;

-- 改單前的會員資料指紋(T1 用)。
select pg_temp.mrow('e9390000-0000-4000-8000-000000000061') as a, pg_temp.mrow('e9390000-0000-4000-8000-000000000062') as b \gset before_

-- =========================================================================
-- T1 改成另一位會員(乙)的電話
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b1_id'::uuid, '0911939002', '王小明(表單)')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row(member_id, member_name_snapshot, customer_name, customer_phone)::text from bookings where id = :'b1_id'::uuid),
  row('e9390000-0000-4000-8000-000000000062'::uuid, '會員乙', '王小明(表單)', '0911939002')::text,
  'T1a 改電話 ⇒ 改掛到乙;姓名快照 = 會員資料的姓名;customer_name 照表單'
);
select is(
  pg_temp.mrow('e9390000-0000-4000-8000-000000000061') || '/' || pg_temp.mrow('e9390000-0000-4000-8000-000000000062'),
  :'before_a' || '/' || :'before_b',
  'T1b 原會員甲、新會員乙的會員資料一個欄位都沒變(A-7 / A-8)'
);

-- =========================================================================
-- T2 改成沒人用的電話 ⇒ 自動建立
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b2_id'::uuid, '0911939102', '新客人', p_email => 'new@r939.test')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row(count(*), min(m.name), min(m.email), min(m.status))::text from members m
   where m.merchant_id = 'e9390000-0000-4000-8000-000000000021' and m.phone = '0911939102'),
  row(1::bigint, '新客人', 'new@r939.test', 'active')::text,
  'T2a 自動建立 1 位會員:姓名 = 表單姓名、電話 = 新電話、email 有帶'
);
select is(
  (select row(b.member_id = m.id, b.member_auto_created)::text from bookings b
   join members m on m.phone = '0911939102' and m.merchant_id = b.merchant_id where b.id = :'b2_id'::uuid),
  row(true, false)::text,
  'T2b 訂單掛到新會員;member_auto_created 不改(A-9)'
);

-- =========================================================================
-- T3 只改格式 / T4 改成原會員資料上的新電話
-- =========================================================================
select count(*) as n from member_point_transactions where booking_id = :'b3_id'::uuid \gset t3before_
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b3_id'::uuid, '0911-939-009')).id \gset ignore_
select (pg_temp.upd(:'b4_id'::uuid, '0911939020')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row(b.member_id, b.points_redeemed, b.customer_phone,
              (select count(*) from member_point_transactions t where t.booking_id = b.id),
              (select count(*) from members m where m.phone like '%939%009%' and m.id <> 'e9390000-0000-4000-8000-000000000069'))::text
   from bookings b where b.id = :'b3_id'::uuid),
  row('e9390000-0000-4000-8000-000000000069'::uuid, 100, '0911-939-009', :'t3before_n'::bigint, 0::bigint)::text,
  'T3 只改格式(0911939009 → 0911-939-009)不算改電話:仍掛壬、折抵不動、分類帳 0 新列、沒有誤建會員'
);
select is(
  (select row(b.member_id, (select count(*) from member_point_transactions t where t.booking_id = b.id))::text
   from bookings b where b.id = :'b4_id'::uuid),
  row('e9390000-0000-4000-8000-000000000070'::uuid, 0::bigint)::text,
  'T4 新電話 = 原會員資料上目前的電話 ⇒ 仍掛癸、分類帳 0 列(A-3)'
);

-- =========================================================================
-- T5 原單有折抵 300 點 ⇒ 全數退回原會員
-- =========================================================================
select points_balance as bal from members where id = 'e9390000-0000-4000-8000-000000000061' \gset t5a_
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b5_id'::uuid, '0911939002')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row(t.points_delta, t.note)::text from member_point_transactions t
   where t.booking_id = :'b5_id'::uuid and t.member_id = 'e9390000-0000-4000-8000-000000000061'
     and t.transaction_type = 'redeem_booking_refund'),
  row(300, '訂單編輯變更了會員或折抵點數，先退回原本的紅利折抵 300 點')::text,
  'T5a 原會員甲有 redeem_booking_refund +300,備註為全形版'
);
select is(
  (select points_balance from members where id = 'e9390000-0000-4000-8000-000000000061'),
  :'t5a_bal'::int + 300,
  'T5b 甲餘額回復 300 點'
);
select is(
  (select row(member_id, points_redeemed, points_redeem_amount_snapshot)::text from bookings where id = :'b5_id'::uuid),
  row('e9390000-0000-4000-8000-000000000062'::uuid, 0, 0.00::numeric(12,2))::text,
  'T5c 訂單改掛乙、折抵歸 0'
);

-- =========================================================================
-- T6 改掛 + 對新會員折抵
-- =========================================================================
select points_balance as bal from members where id = 'e9390000-0000-4000-8000-000000000062' \gset t6b_
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b6_id'::uuid, '0911939002', p_redeemed => 100,
                    p_redeem_member => 'e9390000-0000-4000-8000-000000000062')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row(b.member_id, b.points_redeemed,
              (select string_agg(t.transaction_type || ':' || t.points_delta || ':' || (t.member_id = 'e9390000-0000-4000-8000-000000000062')::text, ',')
               from member_point_transactions t where t.booking_id = b.id),
              (select points_balance from members where id = 'e9390000-0000-4000-8000-000000000062'))::text
   from bookings b where b.id = :'b6_id'::uuid),
  row('e9390000-0000-4000-8000-000000000062'::uuid, 100, 'redeem_booking:-100:true', :'t6b_bal'::int - 100)::text,
  'T6a 改掛乙並對乙折抵 100 點(帶乙的 id)⇒ 乙被扣、分類帳 redeem_booking −100'
);
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select throws_ok(
  format($$select (pg_temp.upd(%L::uuid, '0911939002', p_redeemed => 100,
                               p_redeem_member => 'e9390000-0000-4000-8000-000000000061')).id$$, :'b6x_id'),
  'P0001', '客戶已變更，紅利折抵已重設，請重新確認後送出',
  'T6b 改電話後還帶原會員甲的 id 折抵 ⇒ 擋下(裁決 22 ① 比對依電話算出的會員)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- T7 派點
-- =========================================================================
select is(
  (select row(points_planned, points_planned_auto)::text from bookings where id = :'b7_id'::uuid),
  row(10, 10)::text,
  'T7 前提:甲(綁 LINE)的單 planned = auto = 10'
);
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b7_id'::uuid, '0911939002')).id \gset ignore_
select (pg_temp.upd(:'b7o_id'::uuid, '0911939002')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row(points_planned, points_planned_auto, points_planned_overridden)::text from bookings where id = :'b7_id'::uuid),
  row(0, 0, false)::text,
  'T7a 未人工設定 ⇒ 依新會員乙(沒綁 LINE)重算:planned = auto = 0'
);
select is(
  (select row(points_planned, points_planned_auto, points_planned_overridden)::text from bookings where id = :'b7o_id'::uuid),
  row(50, 0, true)::text,
  'T7b 已人工設定 50 ⇒ planned 保留 50,只更新建議值為 0'
);

-- =========================================================================
-- T8 沒連結會員的舊單改電話
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b8_id'::uuid, '0911939002')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select coalesce(member_id::text, 'NULL') from bookings where id = :'b8_id'::uuid),
  'NULL',
  'T8 沒連結會員的舊單改成乙的電話 ⇒ 仍然沒有會員(補掛要客服明確點選,A-5)'
);

-- =========================================================================
-- T9 服務人員改電話
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000005');
select pg_temp.sup(:'b9_id'::uuid, '0911939002') ->> 'id' as id \gset ignore_
select pg_temp.sup(:'b9n_id'::uuid, '0911939109', '服務人員帶來的新客') ->> 'id' as id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row(member_id, member_name_snapshot, customer_name)::text from bookings where id = :'b9_id'::uuid),
  row('e9390000-0000-4000-8000-000000000062'::uuid, '會員乙', '服務人員改的姓名')::text,
  'T9a 服務人員改成乙的電話 ⇒ 改掛乙(同 T1)'
);
select is(
  (select row(m.name, m.phone, m.merchant_id, b.member_id = m.id)::text
   from bookings b join members m on m.phone = '0911939109' where b.id = :'b9n_id'::uuid),
  row('服務人員帶來的新客', '0911939109', 'e9390000-0000-4000-8000-000000000021'::uuid, true)::text,
  'T9b 服務人員改成沒人用的電話 ⇒ 自動建立會員並改掛(同 T2)'
);
select is(
  (select created_by_user_id from members where phone = '0911939109'),
  'e9390000-0000-4000-8000-000000000005'::uuid,
  'T9c 自動建立的會員建立者 = 服務人員本人的帳號(create_member 照建單規則)'
);

-- =========================================================================
-- T10 已完成單:完成 → 還原 → 改電話 → 再完成
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select id from public.confirm_booking(:'b10_id'::uuid) \gset ignore_
select id from public.complete_booking(:'b10_id'::uuid) \gset ignore_
select id from public.confirm_booking(:'b10s_id'::uuid) \gset ignore_
select id from public.complete_booking(:'b10s_id'::uuid) \gset ignore_
select pg_temp.test_clear_auth();
-- 辛的點數被用掉一部分(剩 4 點,不夠收回 10 點)。
update members set points_balance = 4 where id = 'e9390000-0000-4000-8000-000000000068';
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select public.revert_completed_booking(:'b10_id'::uuid, '客戶打錯') ->> 'booking_id' as x \gset ignore_
select public.revert_completed_booking(:'b10s_id'::uuid, '客戶打錯') ->> 'booking_id' as x \gset ignore_
select (pg_temp.upd(:'b10_id'::uuid, '0911939003')).id \gset ignore_
select (pg_temp.upd(:'b10s_id'::uuid, '0911939003')).id \gset ignore_
select id from public.complete_booking(:'b10_id'::uuid) \gset ignore_
select id from public.complete_booking(:'b10s_id'::uuid) \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select row((select points_balance from members where id = 'e9390000-0000-4000-8000-000000000067'),
              (select sum(points_delta) from member_point_transactions
               where booking_id = :'b10_id'::uuid and member_id = 'e9390000-0000-4000-8000-000000000067'
                 and transaction_type = 'earn_booking_reversal'))::text),
  row(0, -10::bigint)::text,
  'T10a 原會員庚:入帳 10 點被收回(earn_booking_reversal −10),餘額 0'
);
select is(
  (select row((select points_balance from members where id = 'e9390000-0000-4000-8000-000000000068'),
              (select sum(points_delta) from member_point_transactions
               where booking_id = :'b10s_id'::uuid and member_id = 'e9390000-0000-4000-8000-000000000068'
                 and transaction_type = 'earn_booking_reversal'))::text),
  row(0, -4::bigint)::text,
  'T10b 原會員辛點數不夠收回 ⇒ 扣到 0 為止(只收回 4 點)'
);
select is(
  (select string_agg(t.points_delta::text, ',' order by t.booking_id)
   from member_point_transactions t
   where t.member_id = 'e9390000-0000-4000-8000-000000000063' and t.transaction_type = 'earn_booking'
     and t.booking_id in (:'b10_id'::uuid, :'b10s_id'::uuid)),
  '10,10',
  'T10c 新會員丙兩張單都拿滿 points_planned(10 點),不受原會員收回不足影響'
);
select is(
  (select row(member_id, status)::text from bookings where id = :'b10s_id'::uuid),
  row('e9390000-0000-4000-8000-000000000063'::uuid, 'completed')::text,
  'T10d 再完成後訂單掛在丙、狀態已完成'
);

-- =========================================================================
-- T11 黑名單 / T12 只對到已下架 / T13 只對到別家商家
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select (pg_temp.upd(:'b11_id'::uuid, '0911939004')).id \gset ignore_
select (pg_temp.upd(:'b12_id'::uuid, '0911939005', '重新來的客人')).id \gset ignore_
select (pg_temp.upd(:'b13_id'::uuid, '0911939013', '跟別家同號的客人')).id \gset ignore_
select pg_temp.test_clear_auth();
select is(
  (select member_id from bookings where id = :'b11_id'::uuid),
  'e9390000-0000-4000-8000-000000000064'::uuid,
  'T11 新會員是黑名單 ⇒ 照樣改掛(A-6)'
);
select is(
  (select row(m.status, m.name, m.id <> 'e9390000-0000-4000-8000-000000000065',
              (select status from members where id = 'e9390000-0000-4000-8000-000000000065'))::text
   from bookings b join members m on m.id = b.member_id where b.id = :'b12_id'::uuid),
  row('active', '重新來的客人', true, 'removed')::text,
  'T12 新電話只對到已下架會員 ⇒ 建一位新的 active 會員,已下架那位維持下架'
);
select is(
  (select row(m.merchant_id, m.name, m.id <> 'e9390000-0000-4000-8000-000000000072')::text
   from bookings b join members m on m.id = b.member_id where b.id = :'b13_id'::uuid),
  row('e9390000-0000-4000-8000-000000000021'::uuid, '跟別家同號的客人', true)::text,
  'T13a 新電話只對到別家商家的會員 ⇒ 不掛別家,在本店建新會員'
);
select is(
  (select row(points_balance, name)::text from members where id = 'e9390000-0000-4000-8000-000000000072'),
  row(900, '別家客人')::text,
  'T13b 別家商家的會員完全沒被碰'
);

-- =========================================================================
-- T14 預覽一致性
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select pg_temp.pv(:'b14_id'::uuid, '0911939002') -> 'member' ->> 'resolution' as res,
       pg_temp.pv(:'b14_id'::uuid, '0911939002') -> 'member' ->> 'member_id' as mid \gset pv14_
select (pg_temp.upd(:'b14_id'::uuid, '0911939002')).member_id as mid \gset up14_
select pg_temp.pv(:'b14n_id'::uuid, '0911939114') -> 'member' ->> 'resolution' as res \gset pv14n_
select (pg_temp.upd(:'b14n_id'::uuid, '0911939114')).member_id as mid \gset up14n_
select pg_temp.pv(:'b1_id'::uuid, '0911') -> 'member' ->> 'resolution' as res \gset pv14i_
select pg_temp.pv(:'b1_id'::uuid, '0911-939-002') -> 'member' ->> 'resolution' as res \gset pv14g_
select pg_temp.pv(:'b3_id'::uuid, '0911939019') -> 'member' ->> 'resolution' as res,
       pg_temp.pv(:'b3_id'::uuid, '0911939019') -> 'member' ->> 'member_id' as mid \gset pv14h_
select pg_temp.test_clear_auth();
select is(
  :'pv14_res' || '/' || :'pv14_mid',
  'existing/' || :'up14_mid',
  'T14a 預覽 existing,對到的會員 = update_booking 改掛的會員(乙)'
);
select is(
  :'pv14n_res' || '/' || (select phone from members where id = :'up14n_mid'::uuid),
  'new/0911939114',
  'T14b 預覽 new ⇒ 儲存後真的用這支電話建了新會員'
);
select is(
  :'pv14i_res' || '/' || :'pv14g_res' || '/' || :'pv14h_res' || '/' || :'pv14h_mid',
  'phone_incomplete/given/existing/e9390000-0000-4000-8000-000000000069',
  'T14c 編輯模式:電話打到一半 ⇒ phone_incomplete;只改格式 ⇒ 走原本 given;改成原會員自己的新電話 ⇒ existing(原會員)'
);

-- =========================================================================
-- T15 權限
-- =========================================================================
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000004');
select throws_ok(
  format($$select (pg_temp.upd(%L::uuid, '0911939002')).id$$, :'b14n_id'),
  '42501', null,
  'T15a 沒有 orders 鑰匙的客服(只有會員管理)改單 ⇒ 42501'
);
select pg_temp.test_clear_auth();
select ok(
  not has_function_privilege('authenticated', 'private.resolve_edit_booking_member(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'private.resolve_edit_booking_member(uuid, text)', 'execute')
  and not has_function_privilege('public', 'private.resolve_edit_booking_member(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'private.resolve_edit_booking_member(uuid, text)', 'execute'),
  'T15b 新 helper 對 authenticated / anon / PUBLIC / service_role 都沒有 EXECUTE(前端不能直接呼叫)'
);
select is(
  (select row(p.prosecdef, p.provolatile, array_to_string(p.proconfig, ','))::text
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'resolve_edit_booking_member'),
  row(true, 's', 'search_path=public')::text,
  'T15c 新 helper:SECURITY DEFINER、STABLE、search_path 固定 public'
);
select is(
  (select array_agg(n.nspname || '.' || p.proname || ':' || p.pronargs order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (('public', 'update_booking'), ('public', 'preview_booking_points'), ('private', 'resolve_edit_booking_member'))),
  array['public.preview_booking_points:13', 'private.resolve_edit_booking_member:2', 'public.update_booking:29'],
  'T15d update_booking / preview_booking_points 各只有 1 個版本(簽章不變),helper 1 個版本'
);
select ok(
  has_function_privilege('authenticated', 'public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric)', 'execute')
  and not has_function_privilege('anon', 'public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric)', 'execute'),
  'T15e update_booking / preview_booking_points 權限不變:authenticated 有、anon 沒有'
);
select is(
  (select row(p.prosecdef, array_to_string(p.proconfig, ','))::text from pg_proc p where p.oid = 'public.update_booking'::regproc)
  || (select row(p.prosecdef, array_to_string(p.proconfig, ','))::text from pg_proc p where p.oid = 'public.preview_booking_points'::regproc),
  row(true, 'search_path=public')::text || row(true, 'search_path=public')::text,
  'T15f 兩支改寫的函式仍是 SECURITY DEFINER + search_path = public'
);
select ok(
  obj_description('public.staff_update_booking'::regproc, 'pg_proc') like '%#939%依新電話自動改掛%',
  'T15g staff_update_booking 註解補上 #939(改電話時自動改掛)'
);

-- 預覽不能拿別家的單探測:管理員只有 M 店權限,拿 M 店的單配 X 店 id ⇒ 42501。
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
select throws_ok(
  format($$select public.preview_booking_points('e9390000-0000-4000-8000-000000000022', %L::uuid, null, '0911939013',
                                                pg_temp.items(), false, null, false, null, null, false, null, null)$$, :'b14n_id'),
  '42501', null,
  'T15h 預覽帶別家商家 id ⇒ 42501(不能用別家的單或別家的權限探測會員)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- T16 交易原子性
-- =========================================================================
select points_balance as bal from members where id = 'e9390000-0000-4000-8000-000000000061' \gset t16a_
select pg_temp.test_set_auth('e9390000-0000-4000-8000-000000000001');
-- (a) 改成沒人用的電話又要求折抵(新會員 0 點,畫面也拿不到他的 id)⇒ 擋下,剛建的會員一起回滾。
select throws_ok(
  format($$select (pg_temp.upd(%L::uuid, '0911939116', p_redeemed => 100,
                               p_redeem_member => 'e9390000-0000-4000-8000-000000000061')).id$$, :'b16_id'),
  'P0001', '客戶已變更，紅利折抵已重設，請重新確認後送出',
  'T16a 改掛到新會員又要求折抵 ⇒ 擋下'
);
-- (b) 改成 0 點的既有會員(零點己)又要求折抵 ⇒ 點數不足擋下。
select throws_like(
  format($$select (pg_temp.upd(%L::uuid, '0911939006', p_redeemed => 100,
                               p_redeem_member => 'e9390000-0000-4000-8000-000000000066')).id$$, :'b16_id'),
  '%',
  'T16b 改掛到 0 點的會員又要求折抵 ⇒ 擋下'
);
select pg_temp.test_clear_auth();
select is(
  (select row((select count(*) from members where phone = '0911939116'),
              b.member_id, b.points_redeemed,
              (select points_balance from members where id = 'e9390000-0000-4000-8000-000000000061'),
              (select count(*) from member_point_transactions t where t.booking_id = b.id and t.transaction_type = 'redeem_booking_refund'))::text
   from bookings b where b.id = :'b16_id'::uuid),
  row(0::bigint, 'e9390000-0000-4000-8000-000000000061'::uuid, 200, :'t16a_bal'::int, 0::bigint)::text,
  'T16c 兩次都整筆回滾:沒有多出新會員、訂單仍掛甲、甲的 200 點折抵沒被退、沒有退回紀錄'
);

select * from finish();
rollback;
