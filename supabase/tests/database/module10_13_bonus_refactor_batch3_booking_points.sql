-- 紅利系統重構 批次 3(規格書 .project/specs/紅利系統重構.md §八 批次 3 + 檔尾 v2.4 裁決 4/5/8/12)。
-- 對應 migration:20261001040000_bonus_refactor_batch3_booking_points.sql
--
-- 這一檔鎖住的行為:
--   A. 簽章與權限:create_booking / update_booking 各只剩 1 個版本(27 / 28 個參數)、EXECUTE 只給
--      authenticated(+service_role);兩支新內部函式三個角色都沒有 EXECUTE;SECURITY DEFINER 都有 search_path
--   B. create_booking:預覽 auto_points = 實際寫入的 points_planned_auto(直接比對;既有會員 / 新客戶 /
--      line_bound 新客戶)、人工覆寫邊界、需人工確認、折抵扣點與分類帳、final_amount_snapshot 不扣、
--      折抵各種擋下(餘額不足 / 0 元 / 超過 cap / max_points 不是硬上限 / 未開放 / 功能關閉 / 自動建立的新會員)、
--      交易原子性(餘額不足 ⇒ 訂單與自動建立的會員都不存在)、orders-only 客服可覆寫與折抵
--   C. update_booking:不帶新參數 ⇒ 原折抵完全不動;派點跟著金額走 / 已人工設定保留 / 改用建議值 / 兩者同時擋;
--      同一會員改折抵點數(可用點數含本單凍結)、換會員(舊退新扣 / 舊退不扣)、
--      🔴 不帶 p_member_id(v2.4 裁決 5 R7)與明確清空會員 ⇒ 不留「有折抵、沒會員」;
--      金額調低讓原折抵超過新上限 ⇒ 擋下;已下架會員舊單的改單規則(維持 / 不可加大 / 可改 0 / 不帶會員 / 改掛別位下架會員)
--   D. cancel_booking + private.refund_booking_redeem:退回、冪等、功能關閉照退、會員下架照退、沒折抵不寫列
--   E. 併發保護的靜態守門(先鎖會員列才讀餘額;改單 / 取消先鎖訂單列)—— 真正的兩個連線併發實驗
--      無法在單一交易的 pgTAP 裡做,另在 engineer 回報中記錄本機兩個 session 的實測結果
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

select plan(100);

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

-- 一個服務項目(清洗,單價可調)的 jsonb 陣列。
create function pg_temp.items(p_price numeric)
returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object(
    'service_item_id', 'db130000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', p_price));
$$;

-- v2.4 裁決 22 ①:前端折抵時會帶「預覽對到的會員 id」。測試用這支以 postgres 身分(security definer)
-- 依電話找出伺服器會連結的那位(跟 create_booking 同一支 helper),模擬「畫面跟送出一致」的正常情況。
create function pg_temp.redeem_member(p_phone text)
returns uuid language sql security definer as $$
  select r.member_id from private.resolve_booking_member_by_phone('db130000-0000-4000-8000-000000000021', p_phone) r
  where r.match_count = 1;
$$;

-- 新增訂單(前端新增模式的呼叫方式:不帶 p_member_id,由電話決定會員)。
-- p_redeem_member:不帶 = 帶「這支電話對到的會員」(正常情況);帶別的 id = 模擬畫面還停在上一位會員。
create function pg_temp.mk(p_phone text, p_price numeric, p_day int,
                           p_redeemed int default 0, p_override int default null,
                           p_discount boolean default false, p_redeem_member uuid default null)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'db130000-0000-4000-8000-000000000021',
    p_staff_id => 'db130000-0000-4000-8000-000000000041',
    p_service_items => pg_temp.items(p_price),
    p_start_at => timestamptz '2027-01-01 10:00:00+08' + make_interval(days => p_day),
    p_customer_name => '紅利批次3客人',
    p_customer_phone => p_phone,
    p_payment_method_id => 'db130000-0000-4000-8000-000000000071',
    p_discount_enabled => p_discount,
    p_discount_mode => case when p_discount then 'fixed' end,
    p_discount_value => case when p_discount then 100 end,
    p_points_override => p_override,
    p_points_redeemed => p_redeemed,
    p_points_redeem_member_id => case when p_redeemed > 0
                                      then coalesce(p_redeem_member, pg_temp.redeem_member(p_phone)) end
  );
$$;

-- 改單(新前端的呼叫方式:紅利參數都帶)。p_redeem_member 不帶 = 跟 p_member 相同(正常情況)。
create function pg_temp.upd(p_booking uuid, p_member uuid, p_price numeric,
                            p_redeemed int default null, p_override int default null,
                            p_reset boolean default false, p_redeem_member uuid default null)
returns public.bookings language sql as $$
  select * from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'db130000-0000-4000-8000-000000000041',
    p_service_items => pg_temp.items(p_price),
    p_start_at => (select start_at from public.bookings where id = p_booking),
    p_customer_name => '紅利批次3客人',
    p_customer_phone => (select customer_phone from public.bookings where id = p_booking),
    p_payment_method_id => 'db130000-0000-4000-8000-000000000071',
    p_member_id => p_member,
    p_points_override => p_override,
    p_points_redeemed => p_redeemed,
    p_points_override_reset => p_reset,
    p_points_redeem_member_id => coalesce(p_redeem_member, p_member)
  );
$$;

-- 改單:只改預約時間(金額、會員、折抵都不變;v2.4 裁決 14)。
create function pg_temp.upd_time(p_booking uuid, p_member uuid, p_price numeric, p_start timestamptz)
returns public.bookings language sql as $$
  select * from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'db130000-0000-4000-8000-000000000041',
    p_service_items => pg_temp.items(p_price),
    p_start_at => p_start,
    p_customer_name => '紅利批次3客人',
    p_customer_phone => (select customer_phone from public.bookings where id = p_booking),
    p_payment_method_id => 'db130000-0000-4000-8000-000000000071',
    p_member_id => p_member,
    p_points_override => null,
    p_points_redeemed => null,
    p_points_override_reset => false
  );
$$;

-- 改單(舊呼叫端:帶 p_member_id,但完全不帶三個紅利新參數)。
create function pg_temp.upd_legacy(p_booking uuid, p_member uuid, p_price numeric)
returns public.bookings language sql as $$
  select * from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'db130000-0000-4000-8000-000000000041',
    p_service_items => pg_temp.items(p_price),
    p_start_at => (select start_at from public.bookings where id = p_booking),
    p_customer_name => '紅利批次3客人',
    p_customer_phone => (select customer_phone from public.bookings where id = p_booking),
    p_payment_method_id => 'db130000-0000-4000-8000-000000000071',
    p_member_id => p_member
  );
$$;

-- 改單(v2.4 裁決 5 R7:連 p_member_id 都沒帶的呼叫端)。
create function pg_temp.upd_no_member(p_booking uuid, p_price numeric)
returns public.bookings language sql as $$
  select * from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'db130000-0000-4000-8000-000000000041',
    p_service_items => pg_temp.items(p_price),
    p_start_at => (select start_at from public.bookings where id = p_booking),
    p_customer_name => '紅利批次3客人',
    p_customer_phone => (select customer_phone from public.bookings where id = p_booking),
    p_payment_method_id => 'db130000-0000-4000-8000-000000000071'
  );
$$;

-- 新增模式預覽。
create function pg_temp.pv_new(p_phone text, p_price numeric)
returns jsonb language sql as $$
  select public.preview_booking_points(
    'db130000-0000-4000-8000-000000000021', null, null, p_phone, pg_temp.items(p_price),
    false, null, false, null, null, false, null, null);
$$;

create function pg_temp.bal(p_member uuid)
returns int language sql as $$ select points_balance from public.members where id = p_member; $$;

create function pg_temp.ledger(p_booking uuid)
returns text language sql as $$
  -- 同一個交易裡 created_at 全部相同(now() = 交易開始時間),排序只能用內容,當成「多重集合」比對。
  select coalesce(string_agg(t.transaction_type || ':' || t.points_delta || '@' || t.balance_after, ',' order by t.transaction_type, t.points_delta, t.balance_after), '')
  from public.member_point_transactions t where t.booking_id = p_booking;
$$;

create function pg_temp.redeem_of(p_booking uuid)
returns text language sql as $$
  select row(points_redeemed, points_redeem_amount_snapshot, member_id)::text from public.bookings where id = p_booking;
$$;

grant execute on function pg_temp.items(numeric), pg_temp.mk(text, numeric, int, int, int, boolean, uuid),
  pg_temp.upd(uuid, uuid, numeric, int, int, boolean, uuid), pg_temp.redeem_member(text), pg_temp.upd_legacy(uuid, uuid, numeric),
  pg_temp.upd_no_member(uuid, numeric), pg_temp.pv_new(text, numeric),
  pg_temp.upd_time(uuid, uuid, numeric, timestamptz)
  to authenticated;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('db130000-0000-4000-8000-000000000001', 'pgtap-m1013-admin@test.local'),
  ('db130000-0000-4000-8000-000000000003', 'pgtap-m1013-agent-orders@test.local');

insert into groups (id) values ('db130000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('db130000-0000-4000-8000-000000000021', 'db130000-0000-4000-8000-000000000011', '紅利批次3測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('db130000-0000-4000-8000-000000000021', 'db130000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('db130000-0000-4000-8000-000000000051', 'db130000-0000-4000-8000-000000000021',
   'db130000-0000-4000-8000-000000000003', '客服O(只有訂單)', '0900001301',
   'pgtap-m1013-agent-orders@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('db130000-0000-4000-8000-000000000051', 'orders', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'db130000-0000-4000-8000-000000000021', d, false, '00:00', '23:59' from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('db130000-0000-4000-8000-000000000031', 'db130000-0000-4000-8000-000000000021', '清洗', 1000, 'primary', 30, 'active');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('db130000-0000-4000-8000-000000000041', 'db130000-0000-4000-8000-000000000021', '服務人員A', '0901001301', true);

insert into payment_methods (id, merchant_id, name) values
  ('db130000-0000-4000-8000-000000000071', 'db130000-0000-4000-8000-000000000021', '現場付款');

-- 基本模式:每筆 10 點、最低 500 元;100 點 = 10 元、單次最多 50%。
insert into merchant_member_settings (merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
                                      redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent)
values ('db130000-0000-4000-8000-000000000021', 'basic', 10, 500, 100, 10, 50);

insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('db130000-0000-4000-8000-000000000061', 'db130000-0000-4000-8000-000000000021', '會員一', '0913000101', 'M1013A01', 500, 'active'),
  ('db130000-0000-4000-8000-000000000062', 'db130000-0000-4000-8000-000000000021', '會員二', '0913000102', 'M1013A02', 500, 'active'),
  ('db130000-0000-4000-8000-000000000063', 'db130000-0000-4000-8000-000000000021', '大戶', '0913000103', 'M1013A03', 6000, 'active'),
  ('db130000-0000-4000-8000-000000000064', 'db130000-0000-4000-8000-000000000021', '剛好一百', '0913000104', 'M1013A04', 100, 'active'),
  ('db130000-0000-4000-8000-000000000065', 'db130000-0000-4000-8000-000000000021', '之後會下架', '0913000105', 'M1013A05', 500, 'active'),
  ('db130000-0000-4000-8000-000000000066', 'db130000-0000-4000-8000-000000000021', '早就下架', '0913000106', 'M1013A06', 0, 'removed'),
  ('db130000-0000-4000-8000-000000000067', 'db130000-0000-4000-8000-000000000021', '客服折抵用', '0913000107', 'M1013A07', 500, 'active'),
  ('db130000-0000-4000-8000-000000000068', 'db130000-0000-4000-8000-000000000021', '取消用', '0913000108', 'M1013A08', 500, 'active'),
  ('db130000-0000-4000-8000-000000000069', 'db130000-0000-4000-8000-000000000021', '取消用二', '0913000109', 'M1013A09', 500, 'active'),
  ('db130000-0000-4000-8000-000000000070', 'db130000-0000-4000-8000-000000000021', '改單用', '0913000110', 'M1013A10', 500, 'active'),
  ('db130000-0000-4000-8000-000000000072', 'db130000-0000-4000-8000-000000000021', '清空用', '0913000112', 'M1013A12', 5000, 'active'),
  ('db130000-0000-4000-8000-000000000073', 'db130000-0000-4000-8000-000000000021', '下架調低用', '0913000113', 'M1013A13', 1000, 'active');

-- =========================================================================
-- A. 簽章與權限
-- =========================================================================
select is(
  (select array_agg(pronargs order by pronargs) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking'),
  array[28::smallint],
  'A1 §3.3:create_booking 只剩 1 個版本、28 個參數(v2.4 裁決 22 ① 多 p_points_redeem_member_id;舊 25 參數版已 drop,避免 PGRST203)'
);
select is(
  (select array_agg(pronargs order by pronargs) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_booking'),
  array[29::smallint],
  'A2 §3.4:update_booking 只剩 1 個版本、29 個參數(v2.4 裁決 22 ①)'
);
select ok(
  has_function_privilege('authenticated', 'public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.cancel_booking(uuid, text)', 'execute'),
  'A3:新簽章的 create_booking / update_booking 與 cancel_booking 對 authenticated 開放(正向對照)'
);
select ok(
  not has_function_privilege('anon', 'public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid)', 'execute')
  and not has_function_privilege('public', 'public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid)', 'execute')
  and not has_function_privilege('public', 'public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.cancel_booking(uuid, text)', 'execute'),
  'A4 權限衛生規則 1:drop/recreate 後重收權限 —— anon / PUBLIC 都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'private.refund_booking_redeem(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.refund_booking_redeem(uuid)', 'execute')
  and not has_function_privilege('public', 'private.refund_booking_redeem(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.validate_booking_redeem(uuid, uuid, integer, numeric, integer)', 'execute')
  and not has_function_privilege('anon', 'private.validate_booking_redeem(uuid, uuid, integer, numeric, integer)', 'execute')
  and not has_function_privilege('public', 'private.validate_booking_redeem(uuid, uuid, integer, numeric, integer)', 'execute'),
  'A5 §3.11.1:refund_booking_redeem / validate_booking_redeem 三個角色都沒有 EXECUTE(只准內部呼叫)'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (('public','create_booking'),('public','update_booking'),('public','cancel_booking'),
                                    ('private','refund_booking_redeem'),('private','validate_booking_redeem'))
     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public%'),
  5,
  'A6 資安清單:五支 SECURITY DEFINER 函式都固定 search_path = public'
);

-- =========================================================================
-- B. create_booking
-- =========================================================================
-- B1 既有會員:預覽 auto_points = 實際寫入的 points_planned_auto(直接比對,v2.4 裁決 8 ②)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select (pg_temp.pv_new('0913000101', 800) ->> 'auto_points')::int as auto, pg_temp.pv_new('0913000101', 800) -> 'member' ->> 'resolution' as res \gset pv1_
select pg_temp.mk('0913000101', 800, 1) as id \gset b1_
select pg_temp.test_clear_auth();
select is(:'pv1_res'::text, 'existing'::text, 'B1a 前提:預覽判定為既有會員');
select is(
  (select row(points_planned_auto, points_planned, points_planned_overridden, member_id)::text from bookings where id = :'b1_id'::uuid),
  row(:'pv1_auto'::int, 10, false, 'db130000-0000-4000-8000-000000000061'::uuid)::text,
  'B1b 預覽 = 實際(既有會員):points_planned_auto = 預覽 auto_points = 10,planned 跟著建議值、未覆寫'
);

-- B2 新客戶(none 模式)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select (pg_temp.pv_new('0913999001', 600) ->> 'auto_points')::int as auto \gset pv2_
select pg_temp.mk('0913999001', 600, 2) as id \gset b2_
select pg_temp.test_clear_auth();
select is(
  (select row(points_planned_auto, member_auto_created)::text from bookings where id = :'b2_id'::uuid),
  row(:'pv2_auto'::int, true)::text,
  'B2 預覽 = 實際(新客戶):自動建立會員的訂單 points_planned_auto = 預覽的全新會員試算(10)'
);
select is(:'pv2_auto'::int, 10, 'B2b 前提:新客戶預覽確實算出 10 點(不是 0 = 兩邊同時壞掉也會相等)');

-- B3 新客戶 + line_bound 模式
update merchant_member_settings set reward_condition_mode = 'line_bound' where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select (pg_temp.pv_new('0913999002', 600) ->> 'auto_points')::int as auto \gset pv3_
select pg_temp.mk('0913999002', 600, 3) as id \gset b3_
select pg_temp.test_clear_auth();
update merchant_member_settings set reward_condition_mode = 'none' where merchant_id = 'db130000-0000-4000-8000-000000000021';
select is(
  (select array[points_planned_auto, points_planned] from bookings where id = :'b3_id'::uuid),
  array[:'pv3_auto'::int, 0],
  'B3 預覽 = 實際(line_bound 模式新客戶):預覽 0 點,訂單 points_planned_auto 也是 0'
);

-- B4~B7 人工覆寫邊界(第 13 題)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000101', 1000, 4, 0, 25) as id \gset b4_
select pg_temp.test_clear_auth();
select is(
  (select row(points_planned, points_planned_auto, points_planned_overridden)::text from bookings where id = :'b4_id'::uuid),
  row(25, 10, true)::text,
  'B4 §2.5:覆寫 25 點 ⇒ planned 25、auto 仍留 10(可稽核)、overridden = true'
);
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like($$ select pg_temp.mk('0913000101', 1000, 5, 0, -1) $$, '派點數不能是負數',
  'B5 §2.5:覆寫負數被擋');
select throws_like($$ select pg_temp.mk('0913000101', 1000, 5, 0, 100001) $$, '單筆訂單最多只能設定 100,000 點%',
  'B6 第 13 題:覆寫 100,001 被擋,白話錯誤');
select pg_temp.mk('0913000101', 1000, 6, 0, 100000) as id \gset b7_
select pg_temp.test_clear_auth();
select is((select points_planned from bookings where id = :'b7_id'::uuid), 100000, 'B7 第 13 題:覆寫剛好 100,000 通過');

-- B8 功能關閉時覆寫被擋
update merchant_member_settings set points_feature_enabled = false where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like($$ select pg_temp.mk('0913000101', 1000, 7, 0, 5) $$, '紅利點數功能已關閉,無法設定派點',
  'B8 §3.3 第 2 步:功能關閉時帶覆寫值被擋');
select throws_like($$ select pg_temp.mk('0913000101', 1000, 7, 100) $$, '紅利點數功能已關閉,無法使用點數折抵',
  'B8b §2.10 第 1 點:功能關閉時不可折抵');
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = true where merchant_id = 'db130000-0000-4000-8000-000000000021';

-- B9 有折扣 ⇒ 需人工確認
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000101', 1000, 8, 0, null, true) as id \gset b9_
select pg_temp.test_clear_auth();
select is(
  (select row(points_review_required, points_planned, final_amount_snapshot)::text from bookings where id = :'b9_id'::uuid),
  row(true, 10, 900.00)::text,
  'B9 §2.5 第 1 點:有折扣 ⇒ points_review_required = true;系統照算(900 元 ≥ 500 ⇒ 10 點)'
);

-- B10 折抵成功:會員二 500 點,折 100 點 = 10 元
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000102', 1000, 9, 100) as id \gset b10_
select pg_temp.test_clear_auth();
select is(pg_temp.redeem_of(:'b10_id'::uuid), row(100, 10.00, 'db130000-0000-4000-8000-000000000062'::uuid)::text,
  'B10a §3.3:訂單記下折抵 100 點 / NT$10,連著會員');
select is(pg_temp.bal('db130000-0000-4000-8000-000000000062'), 400, 'B10b §3.3 第 5 步:建單當下就從餘額扣掉(500 → 400)');
select is(pg_temp.ledger(:'b10_id'::uuid), 'redeem_booking:-100@400', 'B10c §1.5:分類帳一筆 redeem_booking −100、balance_after 400、帶 booking_id');
select is((select final_amount_snapshot from bookings where id = :'b10_id'::uuid), 1000.00,
  'B10d 🔴 第 3 題定案 A:final_amount_snapshot 不扣折抵(仍是 1000)');
select is((select created_by_user_id from member_point_transactions where booking_id = :'b10_id'::uuid),
  'db130000-0000-4000-8000-000000000001'::uuid, 'B10e:分類帳記下操作者(可稽核)');

-- B11 餘額不足 ⇒ 擋下,而且整筆沒有建出來(交易原子性)
select count(*)::int as n from bookings where merchant_id = 'db130000-0000-4000-8000-000000000021' \gset before11_
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like($$ select pg_temp.mk('0913000102', 1000, 10, 401) $$, '這位會員目前只有 400 點,無法折抵 401 點',
  'B11a §2.10 第 5 點:餘額不足被擋,白話錯誤');
select pg_temp.test_clear_auth();
select is(
  array[(select count(*)::int from bookings where merchant_id = 'db130000-0000-4000-8000-000000000021'),
        pg_temp.bal('db130000-0000-4000-8000-000000000062')],
  array[:'before11_n'::int, 400],
  'B11b 交易原子性:折抵被擋時訂單也沒建出來、餘額沒動'
);

-- B12 換算為 0 元的點數擋下(v2.4 裁決 8 ③)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like($$ select pg_temp.mk('0913000102', 1000, 11, 9) $$, '折抵 9 點換算後不到 1 元(目前 100 點 = 10 元),至少要使用 10 點才折得到 1 元',
  'B12 裁決 8 ③:9 點折不到 1 元 ⇒ 擋下並告訴客服最少要幾點');

-- B13 cap:應付 1000、上限 50% = 500 元。5009 點(折 500 元)通過 —— max_points(5000)不是硬上限(v2.4 裁決 12)
select pg_temp.mk('0913000103', 1000, 12, 5009) as id \gset b13_
select throws_like($$ select pg_temp.mk('0913000103', 1000, 13, 992) $$, '這位會員目前只有 991 點,無法折抵 992 點',
  'B13z 前提確認:大戶餘額已被扣到 991(6000 − 5009)');
select pg_temp.test_clear_auth();
select is(pg_temp.redeem_of(:'b13_id'::uuid), row(5009, 500.00, 'db130000-0000-4000-8000-000000000063'::uuid)::text,
  'B13a 裁決 12 / 第 17 題:5009 點(換算 500 元 = cap)通過,不拿 max_points 5000 當硬上限');
update members set points_balance = 6000 where id = 'db130000-0000-4000-8000-000000000063';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like($$ select pg_temp.mk('0913000103', 1000, 14, 5010) $$, '本單最多可折抵 NT$500(應付金額 NT$1000 的 50%),折抵 5010 點可折 NT$501,已超過上限%',
  'B13b §2.10:5010 點(501 元 > cap 500)被擋,白話錯誤');

-- B14 自動建立的新會員不能折抵,而且會員也不會被留下來(整筆回滾)
-- (v2.4 裁決 22 ①:新客戶在送出前沒有會員 id,畫面不會提供折抵;直接打 API 時「要扣誰」對不上,
--  在檢查餘額之前就被擋,訊息改成「客戶已變更…」。原本斷言的是「只有 0 點」。)
select throws_like($$ select pg_temp.mk('0913999003', 1000, 15, 100) $$, '客戶已變更,紅利折抵已重設,請重新確認後送出',
  'B14a §3.3 第 3 步:新客戶(自動建立的會員)⇒ 折抵被擋');
select pg_temp.test_clear_auth();
select is((select count(*)::int from members where phone = '0913999003'), 0,
  'B14b 交易原子性:被擋時自動建立的會員也一起回滾,沒有留下');

-- B15 orders-only 客服可覆寫與折抵(第 4 題定案 A)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000003');
select pg_temp.mk('0913000107', 1000, 16, 50, 7) as id \gset b15_
select pg_temp.test_clear_auth();
select is(
  (select row(points_planned, points_planned_overridden, points_redeemed, points_redeem_amount_snapshot)::text from bookings where id = :'b15_id'::uuid),
  row(7, true, 50, 5.00)::text,
  'B15 第 4 題定案 A:只有 orders 鑰匙的客服可以覆寫派點與折抵'
);

-- B16 商家沒開放折抵
update merchant_member_settings set redeem_max_ratio_percent = 0 where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like($$ select pg_temp.mk('0913000101', 1000, 17, 100) $$, '這間商家尚未開放紅利點數折抵%',
  'B16 §2.10 第 1 點:比例 0 = 不開放折抵 ⇒ 擋下');
select pg_temp.test_clear_auth();
update merchant_member_settings set redeem_max_ratio_percent = 50 where merchant_id = 'db130000-0000-4000-8000-000000000021';

-- B17 負數折抵
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like($$ select pg_temp.mk('0913000101', 1000, 18, -5) $$, '折抵點數不能是負數', 'B17 折抵點數負數被擋');
select pg_temp.test_clear_auth();

-- =========================================================================
-- C. update_booking
-- =========================================================================
-- 準備:改單用會員 500 點,建單折抵 100 點(剩 400)。
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000110', 1000, 20, 100) as id \gset c_
select pg_temp.test_clear_auth();
select count(*)::int as n from member_point_transactions \gset ledger0_

-- C1 🔴 舊呼叫端(不帶三個新參數)⇒ 原折抵完全不動、分類帳沒有新列(§〇.4 判斷 15)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd_legacy(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 1000);
select pg_temp.test_clear_auth();
select is(pg_temp.redeem_of(:'c_id'::uuid), row(100, 10.00, 'db130000-0000-4000-8000-000000000070'::uuid)::text,
  'C1a 判斷 15:不帶 p_points_redeemed 改單 ⇒ 折抵 100 點 / NT$10 原封不動');
select is(array[(select count(*)::int from member_point_transactions), pg_temp.bal('db130000-0000-4000-8000-000000000070')],
  array[:'ledger0_n'::int, 400],
  'C1b 判斷 15:分類帳沒有新列、會員餘額沒動');

-- C2 未覆寫 ⇒ 改金額 auto 重算、planned 跟著走
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 400, 0);
select pg_temp.test_clear_auth();
select is(
  (select row(points_planned_auto, points_planned, points_planned_overridden)::text from bookings where id = :'c_id'::uuid),
  row(0, 0, false)::text,
  'C2 §3.4 第 2 步:金額改成 400(< 500 門檻)⇒ auto 重算成 0,未覆寫的 planned 跟著變 0'
);
select is(pg_temp.bal('db130000-0000-4000-8000-000000000070'), 500,
  'C2b 同一次把折抵改成 0 ⇒ 100 點整筆退回(400 → 500)');

-- C3 已覆寫 ⇒ 改金額保留客服數字
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 400, 0, 33);
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 1000, 0);
select pg_temp.test_clear_auth();
select is(
  (select row(points_planned_auto, points_planned, points_planned_overridden)::text from bookings where id = :'c_id'::uuid),
  row(10, 33, true)::text,
  'C3 第 6 題:已人工設定 33 點後改金額 ⇒ planned 保留 33、auto 更新成 10'
);

-- C4 改用建議值
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 1000, 0, null, true);
select pg_temp.test_clear_auth();
select is(
  (select row(points_planned, points_planned_overridden)::text from bookings where id = :'c_id'::uuid),
  row(10, false)::text,
  'C4 判斷 12:p_points_override_reset ⇒ planned = 新 auto、overridden = false'
);

-- C5 reset + override 同時 ⇒ 擋
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000070', 1000, 0, 5, true) $f$, :'c_id'),
  '不能同時清除人工設定又指定新的點數', 'C5 §3.4:reset 與 override 同時帶 ⇒ 白話錯誤');

-- C6 同一會員改折抵點數:0 → 100 → 50(舊退新扣,差額正確)
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 1000, 100);
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 1000, 50);
select pg_temp.test_clear_auth();
select is(pg_temp.ledger(:'c_id'::uuid),
  'redeem_booking:-100@400,redeem_booking:-100@400,redeem_booking:-50@450,redeem_booking_refund:100@500,redeem_booking_refund:100@500',
  'C6a §3.4 第 3/4 步:每次變動都是「整筆退回舊的 + 依新值重新扣」(建單扣 100 → 改 0 退 100 → 改 100 扣 100 → 改 50 退 100 扣 50),分類帳 append-only');
select is(array[pg_temp.bal('db130000-0000-4000-8000-000000000070')::numeric, (select points_redeem_amount_snapshot from bookings where id = :'c_id'::uuid)],
  array[450::numeric, 5.00],
  'C6b:最後會員餘額 450、折抵金額 NT$5');

-- C7 換會員 A → B,p_points_redeemed = null ⇒ A 退回、B 不被扣
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000061', 1000);
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.bal('db130000-0000-4000-8000-000000000070'), pg_temp.bal('db130000-0000-4000-8000-000000000061'),
        (select points_redeemed from bookings where id = :'c_id'::uuid)],
  array[500, 500, 0],
  'C7 v2.4 裁決 4:換會員但沒指定折抵 ⇒ 原會員 50 點退回、新會員不被扣、訂單折抵歸 0'
);

-- C8 換會員 B → A 且指定折抵 30 ⇒ 舊(B,這時是 0)不動、新(A)被扣 30
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000061', 1000, 30);
select pg_temp.upd(:'c_id'::uuid, 'db130000-0000-4000-8000-000000000070', 1000, 40);
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.bal('db130000-0000-4000-8000-000000000061'), pg_temp.bal('db130000-0000-4000-8000-000000000070')],
  array[500, 460],
  'C8 §2.4 編輯改會員:舊會員(會員一)30 點退回、新會員(改單用)被扣 40'
);

-- C9 🔴 R7:呼叫端連 p_member_id 都沒帶 ⇒ 會員被清空,原折抵一定先退回,不留「有折抵、沒會員」
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd_no_member(:'c_id'::uuid, 1000);
select pg_temp.test_clear_auth();
select is(pg_temp.redeem_of(:'c_id'::uuid), row(0, 0.00, null::uuid)::text,
  'C9a v2.4 裁決 5 R7:沒帶 p_member_id ⇒ 會員清空、折抵歸 0');
select is(pg_temp.bal('db130000-0000-4000-8000-000000000070'), 500, 'C9b R7:原本被扣的 40 點退回給原會員');

-- C10 明確清空會員卻要折抵 ⇒ 擋下
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(format($f$ select pg_temp.upd(%L, null, 1000, 10) $f$, :'c_id'),
  '這筆訂單沒有連結會員,不能使用紅利點數折抵', 'C10 沒有會員的訂單不可折抵');

-- C11 明確傳 p_member_id = null(清除會員)而原本有折抵 ⇒ 先退回
select pg_temp.mk('0913000112', 1000, 21, 100) as id \gset c11_
select pg_temp.upd(:'c11_id'::uuid, null, 1000);
select pg_temp.test_clear_auth();
select is(array[pg_temp.redeem_of(:'c11_id'::uuid), pg_temp.bal('db130000-0000-4000-8000-000000000072')::text],
  array[row(0, 0.00, null::uuid)::text, '5000'],
  'C11 v2.4 裁決 4:明確清除會員 ⇒ 原折抵 100 點退回(5000)、訂單沒有會員也沒有折抵');

-- C12 金額調低讓原折抵超過新上限 ⇒ 擋下(判斷 21)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c11_id'::uuid, 'db130000-0000-4000-8000-000000000072', 1000, 3000);
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000072', 400) $f$, :'c11_id'),
  '本單目前最多可折 NT$200(應付 NT$400 的 50%),原本的紅利折抵 3000 點(NT$300)已超過上限,請先把折抵點數改成 2000 點以下',
  'C12a 判斷 21 / v2.4 裁決 14:1000 → 400 元,原折抵 300 元 > 新上限 200 元 ⇒ 擋下,通用句告訴客服上限與要改成幾點');
select pg_temp.upd(:'c11_id'::uuid, 'db130000-0000-4000-8000-000000000072', 600);
select pg_temp.test_clear_auth();
select is((select array[final_amount_snapshot, points_redeem_amount_snapshot] from bookings where id = :'c11_id'::uuid),
  array[600.00, 300.00],
  'C12b 判斷 21 對照:改成 600 元(上限剛好 300)⇒ 通過,折抵不動');

-- --- v2.4 裁決 14:商家事後把比例從 50% 調低成 10%(600 元的上限變 60 元,原折抵 300 元已超過)---
update merchant_member_settings set redeem_max_ratio_percent = 10 where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd_time(:'c11_id'::uuid, 'db130000-0000-4000-8000-000000000072', 600, '2027-02-01 15:00:00+08');
select pg_temp.test_clear_auth();
select is(
  (select row(start_at, final_amount_snapshot, points_redeemed, points_redeem_amount_snapshot)::text from bookings where id = :'c11_id'::uuid),
  row('2027-02-01 15:00:00+08'::timestamptz, 600.00, 3000, 300.00)::text,
  'C12c v2.4 裁決 14:比例調低後只改時間(應付金額沒變)⇒ 放行,折抵 3000 點 / NT$300 原封不動');
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000072', 700) $f$, :'c11_id'),
  '本單目前最多可折 NT$70(應付 NT$700 的 10%),原本的紅利折抵 3000 點(NT$300)已超過上限%',
  'C12d v2.4 裁決 14:比例調低後改金額(600 → 700)⇒ 重驗上限,擋下');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000072', 600, 2500) $f$, :'c11_id'),
  '本單最多可折抵 NT$60(應付金額 NT$600 的 10%)%',
  'C12e v2.4 裁決 14:折抵點數有變(3000 → 2500)⇒ 照常完整驗證,超過新上限被擋');
select pg_temp.test_clear_auth();
update merchant_member_settings set redeem_max_ratio_percent = 50 where merchant_id = 'db130000-0000-4000-8000-000000000021';

-- C13 同一會員、可用點數含本單凍結(判斷 22):剛好一百 100 點全折,之後改成 90 點
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000104', 1000, 22, 100) as id \gset c13_
select pg_temp.upd(:'c13_id'::uuid, 'db130000-0000-4000-8000-000000000064', 1000, 90);
select pg_temp.test_clear_auth();
select is(array[pg_temp.bal('db130000-0000-4000-8000-000000000064'), (select points_redeemed from bookings where id = :'c13_id'::uuid)],
  array[10, 90],
  'C13 判斷 22:餘額 0 時仍能把本單折抵從 100 改成 90(先退再驗,可用點數含本單凍結)');

-- --- 已下架會員的舊單(v2.4 裁決 5 ③)---
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000105', 1000, 23, 100) as id \gset c14_
select pg_temp.test_clear_auth();
update members set status = 'removed' where id = 'db130000-0000-4000-8000-000000000065';

-- C14 維持原會員(已下架)⇒ 放行、連結與折抵都不動
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c14_id'::uuid, 'db130000-0000-4000-8000-000000000065', 1000);
select pg_temp.test_clear_auth();
select is(pg_temp.redeem_of(:'c14_id'::uuid), row(100, 10.00, 'db130000-0000-4000-8000-000000000065'::uuid)::text,
  'C14 下架規則:原會員已下架的舊單可以照常改單,連結與原折抵維持(改版前這種單永遠改不動)');

-- C15 已下架會員不可加大折抵
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000065', 1000, 150) $f$, :'c14_id'),
  '這位會員已下架,不能增加紅利折抵%', 'C15 下架規則:不可增加折抵');

select pg_temp.test_clear_auth();

-- C15b~d v2.4 裁決 15(QA 實測 #22 情境):已下架會員的舊單折抵 300 點,300 → 400 擋、300 → 100 放行(退差額)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000113', 1000, 24, 300) as id \gset c15_
select pg_temp.test_clear_auth();
update members set status = 'removed' where id = 'db130000-0000-4000-8000-000000000073';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000073', 1000, 400) $f$, :'c15_id'),
  '這位會員已下架,不能增加紅利折抵%', 'C15b 裁決 15:已下架會員 300 → 400 點 ⇒ 擋下');
select pg_temp.upd(:'c15_id'::uuid, 'db130000-0000-4000-8000-000000000073', 1000, 100);
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000073', 1000, 5) $f$, :'c15_id'),
  '折抵 5 點換算後不到 1 元%', 'C15d 裁決 15:調低後換算仍須 >= 1 元(100 → 5 點被擋)');
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.bal('db130000-0000-4000-8000-000000000073')::text, pg_temp.redeem_of(:'c15_id'::uuid)],
  array['900', row(100, 10.00, 'db130000-0000-4000-8000-000000000073'::uuid)::text],
  'C15c 裁決 15:已下架會員 300 → 100 點 ⇒ 放行,差額 200 點退給他(700 → 900),連結保留');
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');

-- C16 改掛到另一位已下架會員 ⇒ 跟以前一樣擋
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000066', 1000) $f$, :'c14_id'),
  '找不到指定的會員,或會員不屬於這間商家/已被下架', 'C16 下架規則:不可改掛到別位已下架會員');

-- C17 已下架會員,折抵改成 0 ⇒ 退回(退回不看狀態)
select pg_temp.upd(:'c14_id'::uuid, 'db130000-0000-4000-8000-000000000065', 1000, 0);
select pg_temp.test_clear_auth();
select is(array[pg_temp.bal('db130000-0000-4000-8000-000000000065'), (select points_redeemed from bookings where id = :'c14_id'::uuid)],
  array[500, 0],
  'C17 下架規則:折抵改 0 ⇒ 100 點退回給已下架會員(退回一律不看狀態)');

-- C18 已下架會員 + 不帶 p_member_id(R7)⇒ 退回、不留「有折抵、沒會員」
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c14_id'::uuid, 'db130000-0000-4000-8000-000000000065', 1000);
select pg_temp.test_clear_auth();
update members set status = 'active' where id = 'db130000-0000-4000-8000-000000000065';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c14_id'::uuid, 'db130000-0000-4000-8000-000000000065', 1000, 80);
select pg_temp.test_clear_auth();
update members set status = 'removed' where id = 'db130000-0000-4000-8000-000000000065';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd_no_member(:'c14_id'::uuid, 1000);
select pg_temp.test_clear_auth();
select is(array[pg_temp.redeem_of(:'c14_id'::uuid), pg_temp.bal('db130000-0000-4000-8000-000000000065')::text],
  array[row(0, 0.00, null::uuid)::text, '500'],
  'C18 R7 + 下架:已下架會員的折抵單被「不帶會員」改單 ⇒ 80 點退回給他,訂單沒有會員也沒有折抵');

-- C19 總守門:整間店沒有任何「有折抵、沒會員」的訂單
select is((select count(*)::int from bookings where merchant_id = 'db130000-0000-4000-8000-000000000021'
           and points_redeemed > 0 and member_id is null), 0,
  'C19 v2.4 裁決 4/5 ④:經過上面所有改單,沒有任何「有折抵、沒會員」的訂單');

-- C20 分類帳與訂單一致:每張單的有效凍結 = bookings.points_redeemed
select is(
  (select count(*)::int from bookings b
   where b.merchant_id = 'db130000-0000-4000-8000-000000000021'
     and b.points_redeemed <> coalesce((select -sum(t.points_delta) from member_point_transactions t
                                         where t.booking_id = b.id and t.transaction_type in ('redeem_booking','redeem_booking_refund')), 0)),
  0,
  'C20 §1.5:每張訂單的「有效凍結」(分類帳淨額)都等於 bookings.points_redeemed'
);

-- C21 功能關閉期間改單:原折抵維持、不重驗上限;但不可新增
update merchant_member_settings set points_feature_enabled = false where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.upd(:'c11_id'::uuid, 'db130000-0000-4000-8000-000000000072', 400);
select pg_temp.test_clear_auth();
select is((select array[points_redeemed::numeric, points_planned_auto::numeric] from bookings where id = :'c11_id'::uuid),
  array[3000::numeric, 0::numeric],
  'C21a 功能關閉:原折抵 3000 點維持(那時已沒有「上限」設定,不擋改單),派點建議值變 0');
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000072', 400, 3100) $f$, :'c11_id'),
  '紅利點數功能已關閉,無法使用點數折抵', 'C21b 功能關閉:不可加大折抵');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000072', 400, null, 5) $f$, :'c11_id'),
  '紅利點數功能已關閉,無法設定派點', 'C21c 功能關閉:不可人工設定派點');
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = true where merchant_id = 'db130000-0000-4000-8000-000000000021';

-- C22 改單時折抵 0 元點數 / 超過 cap 同樣被擋(與建單共用驗證)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000064', 1000, 5) $f$, :'c13_id'),
  '折抵 5 點換算後不到 1 元%', 'C22a 改單:換算 0 元的點數被擋');
select pg_temp.upd(:'c13_id'::uuid, 'db130000-0000-4000-8000-000000000064', 10, 0);
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000064', 10, 60) $f$, :'c13_id'),
  '本單最多可折抵 NT$5(應付金額 NT$10 的 50%%', 'C22b 改單:60 點 = 6 元 > cap(10 元 × 50% = 5 元)被擋');
select pg_temp.test_clear_auth();

-- C23 已完成 / 已取消不能改單(既有狀態檢查不動)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select cancel_booking(:'b1_id'::uuid);
select throws_like(format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000061', 800) $f$, :'b1_id'),
  '已完成或已取消的預約不能編輯%', 'C23 既有狀態檢查不動');
select pg_temp.test_clear_auth();

-- =========================================================================
-- D. cancel_booking + refund_booking_redeem
-- =========================================================================
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000108', 1000, 30, 200) as id \gset d1_
select points_redeemed as ret_redeemed from cancel_booking(:'d1_id'::uuid, '客人取消') \gset d1_
select pg_temp.test_clear_auth();
select is(pg_temp.bal('db130000-0000-4000-8000-000000000068'), 500, 'D1a §3.11.1:取消 ⇒ 折抵 200 點退回(300 → 500)');
select is(pg_temp.ledger(:'d1_id'::uuid), 'redeem_booking:-200@300,redeem_booking_refund:200@500',
  'D1b §1.5:分類帳多一筆 redeem_booking_refund +200');
select is(array[pg_temp.redeem_of(:'d1_id'::uuid), :'d1_ret_redeemed'],
  array[row(0, 0.00, 'db130000-0000-4000-8000-000000000068'::uuid)::text, '0'],
  'D1c:取消後訂單折抵歸 0、會員連結保留;cancel_booking 回傳的那一列也是最新值(0)');
select is((select note from member_point_transactions where booking_id = :'d1_id'::uuid and transaction_type = 'redeem_booking_refund'),
  '訂單取消,退回紅利折抵 200 點', 'D1d:退回紀錄的說明文字是白話');

-- D2 冪等:再呼叫一次 refund 回 0、不寫任何東西
select is(private.refund_booking_redeem(:'d1_id'::uuid), 0, 'D2a §3.11.1 冪等:第二次退回回傳 0');
select is((select count(*)::int from member_point_transactions where booking_id = :'d1_id'::uuid), 2,
  'D2b 冪等:分類帳沒有多出任何一列');
select is(private.refund_booking_redeem('db130000-0000-4000-8000-00000000ffff'), 0, 'D2c:不存在的訂單回 0、不報錯');

-- D3 功能關閉期間取消 ⇒ 照樣退回(那是客人的錢)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000109', 1000, 31, 150) as id \gset d3_
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = false where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select cancel_booking(:'d3_id'::uuid);
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = true where merchant_id = 'db130000-0000-4000-8000-000000000021';
select is(pg_temp.bal('db130000-0000-4000-8000-000000000069'), 500, 'D3 §2.4 功能關閉那一列:取消仍退回折抵');

-- D4 會員已下架時取消 ⇒ 照樣退回
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000109', 1000, 32, 120) as id \gset d4_
select pg_temp.test_clear_auth();
update members set status = 'removed' where id = 'db130000-0000-4000-8000-000000000069';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select cancel_booking(:'d4_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.bal('db130000-0000-4000-8000-000000000069'), 500, 'D4 §3.11.2 統一對照:會員已下架,取消仍退回折抵');

-- D5 沒有折抵的訂單取消 ⇒ 分類帳不寫任何列
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select cancel_booking(:'b2_id'::uuid);
select pg_temp.test_clear_auth();
select is((select count(*)::int from member_point_transactions where booking_id = :'b2_id'::uuid), 0,
  'D5:沒有折抵的訂單取消,分類帳不寫任何列');

-- D6 已完成的訂單仍不能用 cancel_booking(#844 才開新入口,本批不動狀態檢查)
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select confirm_booking(:'b4_id'::uuid);
select complete_booking(:'b4_id'::uuid);
select throws_like(format($f$ select cancel_booking(%L) $f$, :'b4_id'),
  '只有「待確認」或「已確認」狀態的預約可以取消%', 'D6 cancel_booking 既有狀態檢查不動(completed 取消留給 #844)');
select pg_temp.test_clear_auth();

-- D7 取消的訂單不入帳:派點快照保留、沒有 earn_booking
select is(
  (select row(b.points_planned, (select count(*) from member_point_transactions t where t.booking_id = b.id and t.transaction_type = 'earn_booking'))::text
   from bookings b where b.id = :'d1_id'::uuid),
  row(10, 0)::text,
  'D7 §2.4:取消的訂單 points_planned 保留當歷史快照(10),沒有任何入帳'
);

-- =========================================================================
-- F. v2.4 裁決 22 ①:折抵要扣的會員必須等於伺服器實際決定的會員
-- =========================================================================
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(
  $$ select pg_temp.mk('0913000101', 1000, 40, 50, null, false, 'db130000-0000-4000-8000-000000000062') $$,
  '客戶已變更,紅利折抵已重設,請重新確認後送出',
  'F1 🔴 QA 重現:畫面還停在會員二、電話已改成會員一就送出 ⇒ 擋下(不會扣會員一的點)');
select throws_like(
  $$ select id from public.create_booking(
       p_merchant_id => 'db130000-0000-4000-8000-000000000021',
       p_staff_id => 'db130000-0000-4000-8000-000000000041',
       p_service_items => pg_temp.items(1000),
       p_start_at => timestamptz '2027-03-01 10:00:00+08',
       p_customer_name => '沒帶會員id',
       p_customer_phone => '0913000101',
       p_payment_method_id => 'db130000-0000-4000-8000-000000000071',
       p_points_redeemed => 50) $$,
  '客戶已變更,紅利折抵已重設,請重新確認後送出',
  'F2:折抵 > 0 卻沒帶 p_points_redeem_member_id ⇒ 擋下');
select pg_temp.test_clear_auth();
select is((select count(*)::int from bookings where customer_phone = '0913000101'
           and start_at >= '2027-02-09 00:00+08'),
  0, 'F3:被擋的兩次都沒有建出訂單');
select is((select count(*)::int from member_point_transactions t
           join bookings b on b.id = t.booking_id
           where t.member_id = 'db130000-0000-4000-8000-000000000061' and b.start_at >= '2027-02-09 00:00+08'),
  0, 'F4:會員一沒有因為被擋的單多出任何分類帳列');

select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.mk('0913000103', 1000, 41, 100) as id \gset f5_
select pg_temp.test_clear_auth();
select is(pg_temp.redeem_of(:'f5_id'::uuid),
  row(100, 10.00, 'db130000-0000-4000-8000-000000000063'::uuid)::text,
  'F5:會員 id 相符 ⇒ 照常折抵');

select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select throws_like(
  format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000063', 1000, 150, null, false,
                                'db130000-0000-4000-8000-000000000061') $f$, :'f5_id'),
  '客戶已變更,紅利折抵已重設,請重新確認後送出',
  'F6 update_booking:改折抵 > 0 但要扣的會員 ≠ 這張單送出的會員 ⇒ 擋下');
select lives_ok(
  format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000063', 1000, null, null, false,
                                'db130000-0000-4000-8000-000000000061') $f$, :'f5_id'),
  'F7:p_points_redeemed = null(維持)不檢查要扣的會員(維持原折抵,不會新扣任何人)');
select lives_ok(
  format($f$ select pg_temp.upd(%L, 'db130000-0000-4000-8000-000000000063', 1000, 150) $f$, :'f5_id'),
  'F8:會員 id 相符 ⇒ 改折抵照常');
select pg_temp.test_clear_auth();
select is(pg_temp.redeem_of(:'f5_id'::uuid),
  row(150, 15.00, 'db130000-0000-4000-8000-000000000063'::uuid)::text,
  'F9:被擋那次沒有動到折抵;相符那次改成 150 點');

-- =========================================================================
-- G. 預覽 = 實際 補強(批次 8 主腦裁決;故障注入 #6 發現 B1~B3 的設定是「每筆 10 點、最低 500」,
--    金額 800/600 怎麼變點數都一樣 ⇒ create_booking 把金額算錯也抓不到)。
--    這裡挑「金額差一點點、點數就不同」的情境,每條直接比對 preview auto_points 與 bookings.points_planned_auto,
--    並寫死預期點數(避免兩邊同時壞掉也相等)。
--    驗證有效:暫時把 create_booking 送進引擎的金額 +100 ⇒ G1/G2a 轉紅;暫時只送第一個項目 ⇒ G3/G4 轉紅。
-- =========================================================================
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('db130000-0000-4000-8000-000000000032', 'db130000-0000-4000-8000-000000000021', '加購', 100, 'primary', 10, 'active');

create function pg_temp.pv_items(p_phone text, p_items jsonb)
returns int language sql as $$
  select (public.preview_booking_points(
    'db130000-0000-4000-8000-000000000021', null, null, p_phone, p_items,
    false, null, false, null, null, false, null, null) ->> 'auto_points')::int;
$$;

create function pg_temp.mk_items(p_phone text, p_items jsonb, p_day int)
returns int language sql as $$
  select points_planned_auto from public.create_booking(
    p_merchant_id => 'db130000-0000-4000-8000-000000000021',
    p_staff_id => 'db130000-0000-4000-8000-000000000041',
    p_service_items => p_items,
    p_start_at => timestamptz '2027-06-01 10:00:00+08' + make_interval(days => p_day),
    p_customer_name => '紅利批次8補強客人',
    p_customer_phone => p_phone,
    p_payment_method_id => 'db130000-0000-4000-8000-000000000071'
  );
$$;

create function pg_temp.items2(p_price31 numeric, p_qty31 int, p_price32 numeric, p_qty32 int)
returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('service_item_id', 'db130000-0000-4000-8000-000000000031', 'quantity', p_qty31, 'unit_price', p_price31),
    jsonb_build_object('service_item_id', 'db130000-0000-4000-8000-000000000032', 'quantity', p_qty32, 'unit_price', p_price32));
$$;

grant execute on function pg_temp.pv_items(text, jsonb), pg_temp.mk_items(text, jsonb, int),
  pg_temp.items2(numeric, int, numeric, int) to authenticated;

-- G1 基本模式「每滿額累計」:每滿 100 元 1 點,990 元 ⇒ 9 點(差 10 元就是 10 點)。
update merchant_member_settings
set earn_mode = 'basic', basic_points_per_order = 1, basic_min_amount = 100, basic_tiered_enabled = true
where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.pv_items('0913000101', pg_temp.items(990)) as pv, pg_temp.mk_items('0913000101', pg_temp.items(990), 1) as act \gset g1_
select pg_temp.test_clear_auth();
select is(array[:'g1_pv'::int, :'g1_act'::int], array[9, 9],
  'G1 預覽 = 實際(每滿額累計,990 元差 10 元到下一級):預覽 9 點、建單 points_planned_auto 也是 9');

-- G2 最低消費門檻邊界:每筆 10 點、最低 500 元。499 ⇒ 0 點;500 ⇒ 10 點。
update merchant_member_settings
set basic_points_per_order = 10, basic_min_amount = 500, basic_tiered_enabled = false
where merchant_id = 'db130000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.pv_items('0913000101', pg_temp.items(499)) as pv, pg_temp.mk_items('0913000101', pg_temp.items(499), 2) as act \gset g2a_
select pg_temp.pv_items('0913000101', pg_temp.items(500)) as pv, pg_temp.mk_items('0913000101', pg_temp.items(500), 3) as act \gset g2b_
select pg_temp.test_clear_auth();
select is(array[:'g2a_pv'::int, :'g2a_act'::int], array[0, 0],
  'G2a 預覽 = 實際(門檻差 1 元:499 元):預覽 0 點、建單也是 0 點');
select is(array[:'g2b_pv'::int, :'g2b_act'::int], array[10, 10],
  'G2b 預覽 = 實際(剛好等於門檻 500 元):預覽 10 點、建單也是 10 點');

-- G3/G4 進階模式多項目:清洗單價 ≥ 500 每個 3 點、加購不限單價每個 2 點。
update merchant_member_settings set earn_mode = 'advanced'
where merchant_id = 'db130000-0000-4000-8000-000000000021';
insert into merchant_point_formulas (merchant_id, name, enabled, service_item_id, min_unit_price, points_per_unit, sort_order) values
  ('db130000-0000-4000-8000-000000000021', '清洗公式', true, 'db130000-0000-4000-8000-000000000031', 500, 3, 1),
  ('db130000-0000-4000-8000-000000000021', '加購公式', true, 'db130000-0000-4000-8000-000000000032', 0, 2, 2);
select pg_temp.test_set_auth('db130000-0000-4000-8000-000000000001');
select pg_temp.pv_items('0913000101', pg_temp.items2(600, 2, 100, 3)) as pv,
       pg_temp.mk_items('0913000101', pg_temp.items2(600, 2, 100, 3), 4) as act \gset g3_
select pg_temp.pv_items('0913000101', pg_temp.items2(499, 2, 100, 3)) as pv,
       pg_temp.mk_items('0913000101', pg_temp.items2(499, 2, 100, 3), 5) as act \gset g4_
select pg_temp.test_clear_auth();
select is(array[:'g3_pv'::int, :'g3_act'::int], array[12, 12],
  'G3 預覽 = 實際(進階多項目:清洗 600×2 = 6 點 + 加購 ×3 = 6 點):預覽 12、建單 12');
select is(array[:'g4_pv'::int, :'g4_act'::int], array[6, 6],
  'G4 預覽 = 實際(進階多項目,清洗單價 499 差 1 元沒達門檻 ⇒ 只算加購 6 點):預覽 6、建單 6');

-- 還原成本檔前面用的設定(下面 E 段只做靜態檢查,保險起見仍還原)。
delete from merchant_point_formulas where merchant_id = 'db130000-0000-4000-8000-000000000021';
update merchant_member_settings
set earn_mode = 'basic', basic_points_per_order = 10, basic_min_amount = 500, basic_tiered_enabled = false
where merchant_id = 'db130000-0000-4000-8000-000000000021';

-- =========================================================================
-- E. 併發保護的靜態守門
-- =========================================================================
select ok(
  (select prosrc ~ 'select points_balance into v_member_balance\s+from public\.members\s+where id = v_effective_member_id\s+for update'
   from pg_proc where oid = 'public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid)'::regprocedure),
  'E1 規則 2.3:create_booking 折抵前先 for update 鎖會員列才讀餘額(兩張單同時折抵不會把點數用兩次)'
);
select ok(
  (select prosrc ~ 'from public\.bookings\s+where id = p_booking_id\s+for update'
   from pg_proc where oid = 'public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid)'::regprocedure)
  and (select prosrc ~ 'from public\.members\s+where id in \(v_old_member_id, p_member_id\)\s+order by id\s+for update'
   from pg_proc where oid = 'public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid)'::regprocedure),
  'E2:update_booking 先鎖訂單列、再依 id 順序鎖新舊會員列(避免交叉死鎖)'
);
select ok(
  (select prosrc ~ 'where id = p_booking_id\s+for update' from pg_proc where oid = 'public.cancel_booking(uuid, text)'::regprocedure)
  and (select prosrc ~ 'where b\.id = p_booking_id\s+for update' from pg_proc where oid = 'private.refund_booking_redeem(uuid)'::regprocedure),
  'E3:cancel_booking 與 refund_booking_redeem 都先鎖訂單列(退回在鎖之後才算淨額 ⇒ 同時取消兩次也只退一次)'
);

select * from finish();
rollback;
