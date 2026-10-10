-- #844 已完成訂單可取消/還原 —— pgTAP module17_02(批次 3 = migration C)
-- 規格:.project/specs/已完成訂單取消與還原.md v1.2 §2.4、§3.11、§4.7、§4.8、§七 邊界 19~22、§十 module17_02;
--       檔尾 ✅ 使用者裁決 Q11 = A(補到應得:v_topup := points_planned − v_net,> 0 才寫)。
-- 對應 migration:20261001090200_req844_earn_booking_net_idempotency.sql
--
--   A. 結構:唯一索引已不存在;complete_booking 讀狀態有 for update;權限沒有被放寬。
--   B. 完成 → 還原 → 再完成:第二次 earn_booking 寫入、餘額正確、本單有效入帳 = points_planned(§十 第 2 條)。
--   C. 冪等:已完成的單再呼叫一次 compute_member_loyalty_points 不重複入帳(§十 第 3 條)。
--   D. 部分收回 → 還原 → 再完成:補到應得(Q11 A)(§十 第 4 條)。
--   E. 還原後改單讓 points_planned 變動:沒差額時用新數字;差額比新派點多時不補、不倒扣(§十 第 5 條,邊界 21)。
--   F. 還原後換會員:新會員拿滿、舊會員差額留著;再取消一次兩位都被收回(§十 第 6 條,邊界 19)。
--   G. 推薦後續獎勵 (a)~(d)(§十 第 7 條)。
--   H. 首次推薦獎勵:全額收回 → 再發一次;推薦人有差額 → 不清標記、不再發首次(§十 第 8 條)。
--   I. get_member_related_bookings:earned_points = 本單本會員有效入帳、reversed_points、從未入帳 null、anon 不能執行(§十 第 9 條)。
--   J. render_booking_notification_variables:points_earned = 有效入帳,不是最後一筆(§十 第 10 條)。
-- 兩條連線同時完成(§3.11 / 邊界 22)pgTAP 單一連線測不到,實測結果在 engineer 回報。
--
-- 【故障注入(2026-10-01 台北 12:28,本機容器 create or replace 後跑本檔,再重跑 migration C 還原)】
--   ① 拿掉淨額檢查(v_topup := v_points_planned)→ 16 條轉紅:C1 C2 D2~D6 E2 E3 G5 I1~I3 J1~J3(重複入帳)。
--   ② 推薦後續獎勵「達標」改回 v_inserted(= 這次真的寫入)→ G5 轉紅。
--   ③ 淨額不限本單目前會員(拿掉 member_id = v_member_id)→ F2 F3 I5 轉紅(新會員只補到 10 點)。
--   ④ render_booking_notification_variables 改回「最新一筆 earn_booking」→ J1 J2 J4 轉紅。
--   ⑤ 「達標」改成 QA 原寫法「淨額從 0 變 > 0」(v_net = 0 and v_net_after > 0)→ G4 G5 轉紅。
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

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

select plan(56);

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

create temporary sequence m172seq;

-- 建單(電話連結既有會員;每張單排不同天,避免時段衝突)。
create function pg_temp.mk(p_phone text, p_name text, p_override int default null)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'e8440000-0000-4000-8000-000000000321',
    p_staff_id => 'e8440000-0000-4000-8000-000000000351',
    p_service_items => jsonb_build_array(jsonb_build_object(
      'service_item_id', 'e8440000-0000-4000-8000-000000000341', 'quantity', 1, 'unit_price', 1000)),
    p_start_at => timestamptz '2027-05-01 10:00:00+08' + make_interval(days => nextval('pg_temp.m172seq')::int),
    p_customer_name => p_name,
    p_customer_phone => p_phone,
    p_payment_method_id => 'e8440000-0000-4000-8000-000000000361',
    p_points_override => p_override
  );
$$;

-- 改單:只改人工派點與(可選)會員,其餘照原單。
create function pg_temp.upd(p_booking uuid, p_member uuid, p_override int default null)
returns void language sql as $$
  select null::void from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'e8440000-0000-4000-8000-000000000351',
    p_service_items => jsonb_build_array(jsonb_build_object(
      'service_item_id', 'e8440000-0000-4000-8000-000000000341', 'quantity', 1, 'unit_price', 1000)),
    p_start_at => (select start_at from public.bookings where id = p_booking),
    p_customer_name => (select customer_name from public.bookings where id = p_booking),
    p_customer_phone => (select customer_phone from public.bookings where id = p_booking),
    p_payment_method_id => 'e8440000-0000-4000-8000-000000000361',
    p_member_id => p_member,
    p_points_override => p_override
  );
$$;

create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  if (select status from public.bookings where id = p_booking) = 'pending_confirmation' then
    perform public.confirm_booking(p_booking);
  end if;
  perform public.complete_booking(p_booking);
end;
$$;

create function pg_temp.bal(p_member uuid)
returns int language sql as $$ select points_balance from public.members where id = p_member; $$;

-- 本單某類型的筆數 / 加總(可指定會員)。
create function pg_temp.cnt(p_booking uuid, p_type text, p_member uuid default null)
returns int language sql as $$
  select count(*)::int from public.member_point_transactions
  where booking_id = p_booking and transaction_type = p_type and (p_member is null or member_id = p_member);
$$;

create function pg_temp.net(p_booking uuid, p_member uuid, p_types text[])
returns int language sql as $$
  select coalesce(sum(points_delta), 0)::int from public.member_point_transactions
  where booking_id = p_booking and member_id = p_member and transaction_type = any(p_types);
$$;

grant usage on sequence pg_temp.m172seq to authenticated;
grant execute on function pg_temp.mk(text, text, int), pg_temp.upd(uuid, uuid, int), pg_temp.done(uuid) to authenticated;

-- -------------------------------------------------------------------------
-- Fixture:四店(管理員丁)、一位按件服務人員;每筆 50 點;推薦開關開、首次 20 點、後續 5 點
-- -------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('e8440000-0000-4000-8000-000000000301', 'pgtap-m172-admin@test.local');
insert into groups (id) values ('e8440000-0000-4000-8000-000000000311');
insert into merchants (id, group_id, name, industry_type) values
  ('e8440000-0000-4000-8000-000000000321', 'e8440000-0000-4000-8000-000000000311', '淨額入帳測試四店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('e8440000-0000-4000-8000-000000000321', 'e8440000-0000-4000-8000-000000000301', '管理員丁');
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e8440000-0000-4000-8000-000000000321', d, false, '00:00', '23:59' from generate_series(0, 6) d;
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('e8440000-0000-4000-8000-000000000341', 'e8440000-0000-4000-8000-000000000321', '保養', 1000, 'primary', 30, 'active');
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('e8440000-0000-4000-8000-000000000351', 'e8440000-0000-4000-8000-000000000321', '四店服務人員', '0901084421', true, 'piece_rate');
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('e8440000-0000-4000-8000-000000000351', 'e8440000-0000-4000-8000-000000000341', 'percentage', 10);
insert into payment_methods (id, merchant_id, name) values
  ('e8440000-0000-4000-8000-000000000361', 'e8440000-0000-4000-8000-000000000321', '現場付款');
insert into merchant_member_settings (
  merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
  referral_inviter_reward_enabled, referral_bonus_points, referral_subsequent_bonus_points
) values ('e8440000-0000-4000-8000-000000000321', 'basic', 50, 0, true, 20, 5);

insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('e8440000-0000-4000-8000-000000000371', 'e8440000-0000-4000-8000-000000000321', '再完成會員', '0916084371', 'M172371', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000372', 'e8440000-0000-4000-8000-000000000321', '補差額會員', '0916084372', 'M172372', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000373', 'e8440000-0000-4000-8000-000000000321', '改少會員', '0916084373', 'M172373', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000374', 'e8440000-0000-4000-8000-000000000321', '舊會員', '0916084374', 'M172374', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000375', 'e8440000-0000-4000-8000-000000000321', '新會員', '0916084375', 'M172375', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000376', 'e8440000-0000-4000-8000-000000000321', '改多會員', '0916084376', 'M172376', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000380', 'e8440000-0000-4000-8000-000000000321', '推薦人後續', '0916084380', 'M172380', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000382', 'e8440000-0000-4000-8000-000000000321', '推薦人首次', '0916084382', 'M172382', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000384', 'e8440000-0000-4000-8000-000000000321', '推薦人沒錢', '0916084384', 'M172384', 0, 'active');
insert into members (id, merchant_id, name, phone, referral_code, points_balance, status, referred_by_member_id) values
  ('e8440000-0000-4000-8000-000000000381', 'e8440000-0000-4000-8000-000000000321', '被推薦後續', '0916084381', 'M172381', 0, 'active', 'e8440000-0000-4000-8000-000000000380'),
  ('e8440000-0000-4000-8000-000000000383', 'e8440000-0000-4000-8000-000000000321', '被推薦首次', '0916084383', 'M172383', 0, 'active', 'e8440000-0000-4000-8000-000000000382'),
  ('e8440000-0000-4000-8000-000000000385', 'e8440000-0000-4000-8000-000000000321', '被推薦沒錢', '0916084385', 'M172385', 0, 'active', 'e8440000-0000-4000-8000-000000000384');

\set m_redo     'e8440000-0000-4000-8000-000000000371'
\set m_topup    'e8440000-0000-4000-8000-000000000372'
\set m_less     'e8440000-0000-4000-8000-000000000373'
\set m_old      'e8440000-0000-4000-8000-000000000374'
\set m_new      'e8440000-0000-4000-8000-000000000375'
\set m_more     'e8440000-0000-4000-8000-000000000376'
\set r_rep      'e8440000-0000-4000-8000-000000000380'
\set e_rep      'e8440000-0000-4000-8000-000000000381'
\set r_first    'e8440000-0000-4000-8000-000000000382'
\set e_first    'e8440000-0000-4000-8000-000000000383'
\set r_poor     'e8440000-0000-4000-8000-000000000384'
\set e_poor     'e8440000-0000-4000-8000-000000000385'

-- 建單 + 完成(全部以管理員丁身分)
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select pg_temp.mk('0916084371', '再完成本單') as id \gset redo_
select pg_temp.done(:'redo_id'::uuid);
select pg_temp.mk('0916084372', '補差額本單') as id \gset topup_
select pg_temp.done(:'topup_id'::uuid);
select pg_temp.mk('0916084373', '改少本單') as id \gset less_
select pg_temp.done(:'less_id'::uuid);
select pg_temp.mk('0916084374', '換會員本單') as id \gset swap_
select pg_temp.done(:'swap_id'::uuid);
select pg_temp.mk('0916084376', '改多本單') as id \gset more_
select pg_temp.done(:'more_id'::uuid);
select pg_temp.mk('0916084371', '從未入帳本單', 0) as id \gset zero_
select pg_temp.done(:'zero_id'::uuid);
-- 推薦:被推薦後續先完成第 1 張(推薦人拿首次 20),之後三張各拿後續 5
select pg_temp.mk('0916084381', '被推薦後續第一張') as id \gset rep0_
select pg_temp.done(:'rep0_id'::uuid);
select pg_temp.mk('0916084381', '後續 a') as id \gset repa_
select pg_temp.done(:'repa_id'::uuid);
select pg_temp.mk('0916084381', '後續 b') as id \gset repb_
select pg_temp.done(:'repb_id'::uuid);
select pg_temp.mk('0916084381', '後續 c') as id \gset repc_
select pg_temp.done(:'repc_id'::uuid);
select pg_temp.mk('0916084381', '後續 e') as id \gset repe_
select pg_temp.done(:'repe_id'::uuid);
-- 首次推薦:兩位被推薦人各自第一張
select pg_temp.mk('0916084383', '首次本單') as id \gset first_
select pg_temp.done(:'first_id'::uuid);
select pg_temp.mk('0916084385', '首次沒錢本單') as id \gset poor_
select pg_temp.done(:'poor_id'::uuid);
select pg_temp.test_clear_auth();

-- =========================================================================
-- A. 結構
-- =========================================================================
select is(
  (select count(*)::int from pg_indexes
   where schemaname = 'public' and indexname = 'member_point_transactions_earn_booking_unique_idx'),
  0,
  'A1 §2.4:earn_booking 每單一筆唯一索引已不存在'
);
select ok(
  (select prosrc ~ 'where id = p_booking_id\s+for update;'
   from pg_proc where oid = 'public.complete_booking(uuid)'::regprocedure),
  'A2 §3.11:complete_booking 讀狀態那一句有 for update(兩人同時完成,第二個看到 completed 被擋)'
);
select ok(
  not has_function_privilege('anon', 'public.compute_member_loyalty_points(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.compute_member_loyalty_points(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.complete_booking(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.complete_booking(uuid)', 'execute'),
  'A3 權限沒有被重設:入帳函式不對外;complete_booking 只給 authenticated'
);
select ok(
  not has_function_privilege('anon', 'public.render_booking_notification_variables(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.render_booking_notification_variables(uuid, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.render_booking_notification_variables(uuid, uuid)', 'execute'),
  'A4 render_booking_notification_variables 仍然只給 service_role'
);

-- =========================================================================
-- B. 完成 → 還原 → 再完成
-- =========================================================================
select is(pg_temp.bal(:'m_redo'::uuid), 50, 'B0 前置:第一次完成入帳 50');
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'redo_id'::uuid, '誤按完成') as r \gset redo_rv_
select is(pg_temp.bal(:'m_redo'::uuid), 0, 'B1 還原:全額收回,餘額 0');
select pg_temp.done(:'redo_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.cnt(:'redo_id'::uuid, 'earn_booking'), 2,
  'B2 §十 第 2 條(核心):再完成時第二筆 earn_booking 寫入成功(索引時代會被 on conflict 靜默吃掉)');
select is(pg_temp.bal(:'m_redo'::uuid), 50, 'B3 餘額回到 50');
select is(pg_temp.net(:'redo_id'::uuid, :'m_redo'::uuid, array['earn_booking', 'earn_booking_reversal']), 50,
  'B4 本單有效入帳 = points_planned 50');
select is(
  (select balance_after from member_point_transactions
   where booking_id = :'redo_id'::uuid and transaction_type = 'earn_booking' order by created_at desc, points_delta limit 1),
  50, 'B5 第二筆 earn_booking 的 balance_after 正確(50)');

-- =========================================================================
-- C. 冪等
-- =========================================================================
select public.compute_member_loyalty_points(:'redo_id'::uuid);
select public.compute_member_loyalty_points(:'more_id'::uuid);
select is(
  pg_temp.cnt(:'redo_id'::uuid, 'earn_booking') || '/' || pg_temp.bal(:'m_redo'::uuid),
  '2/50',
  'C1 §十 第 3 條(核心):再完成過的單再呼叫一次入帳 → 不多寫、餘額不變'
);
select is(
  pg_temp.cnt(:'more_id'::uuid, 'earn_booking') || '/' || pg_temp.bal(:'m_more'::uuid),
  '1/50',
  'C2 一般已完成的單再呼叫一次入帳 → 仍只有 1 筆、餘額不變(取代原本唯一索引的保證)'
);

-- =========================================================================
-- D. 部分收回 → 還原 → 再完成:補到應得(Q11 A)
-- =========================================================================
update members set points_balance = 10 where id = :'m_topup'::uuid;  -- 會員花掉 40 點
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'topup_id'::uuid, '誤按完成,點數已被花掉') as r \gset topup_rv_
select pg_temp.test_clear_auth();
select is(
  (:'topup_rv_r'::jsonb -> 'points' ->> 'points_recovered') || '/' || (:'topup_rv_r'::jsonb -> 'points' ->> 'points_shortfall')
    || '/' || pg_temp.bal(:'m_topup'::uuid),
  '10/40/0',
  'D1 前置:還原時只收回 10、差額 40、餘額 0'
);
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select pg_temp.done(:'topup_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  (select array_agg(points_delta order by created_at, points_delta desc)::text from member_point_transactions
   where booking_id = :'topup_id'::uuid and transaction_type = 'earn_booking'),
  '{50,10}',
  'D2 Q11 A(核心):再完成只補 50 − 40 = 10 點(不是 0、也不是再給 50)'
);
select is(pg_temp.bal(:'m_topup'::uuid), 10, 'D3 會員餘額 0 + 10 = 10');
select is(pg_temp.net(:'topup_id'::uuid, :'m_topup'::uuid, array['earn_booking', 'earn_booking_reversal']), 50,
  'D4 本單有效入帳 = 應得 50(跟從來沒按錯一樣)');
select is(
  (select balance_after from member_point_transactions
   where booking_id = :'topup_id'::uuid and transaction_type = 'earn_booking' and points_delta = 10),
  10, 'D5 補差額那筆 balance_after = 10');
select public.compute_member_loyalty_points(:'topup_id'::uuid);
select is(pg_temp.cnt(:'topup_id'::uuid, 'earn_booking') || '/' || pg_temp.bal(:'m_topup'::uuid), '2/10',
  'D6 補完差額後再呼叫一次 → 不再補');

-- =========================================================================
-- E. 還原後改單讓 points_planned 變動
-- =========================================================================
-- E-1 沒有差額:全額收回 → 改成 80 點 → 再完成拿 80
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'more_id'::uuid, '要改派點') as r \gset more_rv_
select pg_temp.upd(:'more_id'::uuid, :'m_more'::uuid, 80);
select pg_temp.done(:'more_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  (select points_planned from bookings where id = :'more_id'::uuid) || '/'
    || pg_temp.net(:'more_id'::uuid, :'m_more'::uuid, array['earn_booking', 'earn_booking_reversal']) || '/'
    || pg_temp.bal(:'m_more'::uuid),
  '80/80/80',
  'E1 §十 第 5 條:還原後改單成 80 點 → 再完成用新數字,有效入帳 80、餘額 80'
);
-- E-2 邊界 21:差額 40、改成派 30 → 不補、也不倒扣
update members set points_balance = 10 where id = :'m_less'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'less_id'::uuid, '差額後改少') as r \gset less_rv_
select pg_temp.upd(:'less_id'::uuid, :'m_less'::uuid, 30);
select pg_temp.done(:'less_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  pg_temp.cnt(:'less_id'::uuid, 'earn_booking') || '/' || pg_temp.cnt(:'less_id'::uuid, 'earn_booking_reversal')
    || '/' || pg_temp.bal(:'m_less'::uuid),
  '1/1/0',
  'E2 邊界 21(核心):差額 40 > 新派點 30 → 不補(earn_booking 仍 1 筆)、不倒扣(沒有新的收回列、餘額仍 0)'
);
select is(pg_temp.net(:'less_id'::uuid, :'m_less'::uuid, array['earn_booking', 'earn_booking_reversal']), 40,
  'E3 本單有效入帳停在 40(多出來的 10 點留給管理員手動調整)');

-- =========================================================================
-- F. 還原後換會員(邊界 19)
-- =========================================================================
update members set points_balance = 10 where id = :'m_old'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'swap_id'::uuid, '掛錯會員') as r \gset swap_rv_
select pg_temp.upd(:'swap_id'::uuid, :'m_new'::uuid);
select pg_temp.done(:'swap_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.net(:'swap_id'::uuid, :'m_old'::uuid, array['earn_booking', 'earn_booking_reversal']) || '/'
    || pg_temp.bal(:'m_old'::uuid),
  '40/0',
  'F1 舊會員:差額 40 留在分類帳上、餘額 0(再完成不動舊會員)');
select is(pg_temp.cnt(:'swap_id'::uuid, 'earn_booking', :'m_new'::uuid) || '/'
    || pg_temp.net(:'swap_id'::uuid, :'m_new'::uuid, array['earn_booking', 'earn_booking_reversal']) || '/'
    || pg_temp.bal(:'m_new'::uuid),
  '1/50/50',
  'F2 邊界 19(核心):新會員從 0 開始算,拿滿 50(淨額只看本單目前的會員)');
-- 舊會員之後有了 15 點 → 再取消一次:兩位都被收回
update members set points_balance = 15 where id = :'m_old'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select cancel_completed_booking(:'swap_id'::uuid, '最後還是作廢') as r \gset swap_cc_
select pg_temp.test_clear_auth();
select is(
  (:'swap_cc_r'::jsonb -> 'points' ->> 'points_due') || '/' || (:'swap_cc_r'::jsonb -> 'points' ->> 'points_recovered')
    || '/' || (:'swap_cc_r'::jsonb -> 'points' ->> 'points_shortfall'),
  '90/65/25',
  'F3 再取消:應收 50 + 40 = 90、實收 50 + 15 = 65、差額 25(收回函式連舊會員的差額一起收)'
);
select is(pg_temp.bal(:'m_old'::uuid) || '/' || pg_temp.bal(:'m_new'::uuid), '0/0', 'F4 兩位會員都被扣到 0');

-- =========================================================================
-- G. 推薦後續獎勵
-- =========================================================================
select is(
  pg_temp.cnt(:'repa_id'::uuid, 'referral_repeat_bonus') + pg_temp.cnt(:'repb_id'::uuid, 'referral_repeat_bonus')
    + pg_temp.cnt(:'repc_id'::uuid, 'referral_repeat_bonus') + pg_temp.cnt(:'repe_id'::uuid, 'referral_repeat_bonus'),
  4, 'G0 前置:四張後續單各發 5 點後續獎勵');
update members set points_balance = 1000 where id in (:'r_rep'::uuid, :'e_rep'::uuid);

-- (a) 全額收回 → 再完成 → 後續獎勵重新發一次
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'repa_id'::uuid, '後續 a 全額收回') as r \gset repa_rv_
select pg_temp.done(:'repa_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  pg_temp.cnt(:'repa_id'::uuid, 'referral_repeat_bonus') || '/'
    || pg_temp.net(:'repa_id'::uuid, :'r_rep'::uuid, array['referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal']),
  '2/5',
  'G1 (a) 全額收回後再完成 → 後續獎勵重新發一次(本單推薦淨額回到 5)');
-- (d) 同單重複呼叫不重發
select public.compute_member_loyalty_points(:'repa_id'::uuid);
select is(pg_temp.cnt(:'repa_id'::uuid, 'referral_repeat_bonus'), 2, 'G2 (d) 同一張單重複呼叫入帳 → 後續獎勵不重發');

-- (b) 本單會員部分收回、推薦人全額收回 → 再完成時後續獎勵會重新發
update members set points_balance = 10 where id = :'e_rep'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'repb_id'::uuid, '後續 b 部分收回') as r \gset repb_rv_
select pg_temp.test_clear_auth();
select is(
  (:'repb_rv_r'::jsonb -> 'points' ->> 'points_shortfall') || '/' || (:'repb_rv_r'::jsonb -> 'points' ->> 'referral_shortfall'),
  '40/0', 'G3 前置:被推薦人差額 40、推薦人全額收回');
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select pg_temp.done(:'repb_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  pg_temp.cnt(:'repb_id'::uuid, 'referral_repeat_bonus') || '/'
    || pg_temp.net(:'repb_id'::uuid, :'r_rep'::uuid, array['referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal']),
  '2/5',
  'G4 (b)(核心):本單淨額「從 40 變 50」也算達標 → 後續獎勵重新發(「從 0 變 > 0」的寫法在這條會轉紅)');

-- (b') 部分收回後改單把派點改少,這次一點都沒補(沒有新寫入 earn_booking),但本單仍有派到點 → 照樣達標
update members set points_balance = 10 where id = :'e_rep'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'repe_id'::uuid, '後續 e 部分收回再改少') as r \gset repe_rv_
select pg_temp.upd(:'repe_id'::uuid, :'e_rep'::uuid, 30);
select pg_temp.done(:'repe_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  pg_temp.cnt(:'repe_id'::uuid, 'earn_booking') || '/' || pg_temp.cnt(:'repe_id'::uuid, 'referral_repeat_bonus') || '/'
    || pg_temp.net(:'repe_id'::uuid, :'r_rep'::uuid, array['referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal']),
  '1/2/5',
  'G5 (b'')「達標」看本單完成後有效入帳 > 0,不看這次有沒有寫入:沒補點(earn_booking 仍 1 筆)也照樣重發後續獎勵(故障注入 ② 改回 v_inserted 會轉紅)');

-- (c) 推薦人部分收回 → 再完成不重發
update members set points_balance = 0 where id = :'r_rep'::uuid;
update members set points_balance = 1000 where id = :'e_rep'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'repc_id'::uuid, '後續 c 推薦人沒錢') as r \gset repc_rv_
select pg_temp.test_clear_auth();
select is((:'repc_rv_r'::jsonb -> 'points' ->> 'referral_shortfall'), '5', 'G6 前置:推薦人差額 5(沒收回)');
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select pg_temp.done(:'repc_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  pg_temp.cnt(:'repc_id'::uuid, 'referral_repeat_bonus') || '/' || pg_temp.bal(:'r_rep'::uuid),
  '1/0',
  'G7 (c) 推薦人那筆沒收回(本單推薦淨額仍 5)→ 再完成不重發、推薦人餘額不變');
select is(pg_temp.cnt(:'repc_id'::uuid, 'earn_booking'), 2, 'G8 (c) 被推薦人本身照常再入帳(全額收回後拿回 50)');

-- =========================================================================
-- H. 首次推薦獎勵
-- =========================================================================
select is(
  pg_temp.cnt(:'first_id'::uuid, 'referral_bonus') || '/' || pg_temp.bal(:'r_first'::uuid),
  '1/20', 'H0 前置:被推薦人第一張完成 → 推薦人拿首次 20');
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'first_id'::uuid, '首次全額收回') as r \gset first_rv_
select pg_temp.test_clear_auth();
select ok((select referral_rewarded_at is null from members where id = :'e_first'::uuid),
  'H1 推薦人那筆首次獎勵全額收回 → 被推薦人「已領過首次」標記清掉');
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select pg_temp.done(:'first_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  pg_temp.cnt(:'first_id'::uuid, 'referral_bonus') || '/'
    || pg_temp.net(:'first_id'::uuid, :'r_first'::uuid, array['referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal'])
    || '/' || pg_temp.bal(:'r_first'::uuid) || '/' || pg_temp.cnt(:'first_id'::uuid, 'referral_repeat_bonus'),
  '2/20/20/0',
  'H2 §十 第 8 條:再完成(該會員只有這一張已完成)→ 首次獎勵再發一次(不是發成後續 5 點)');
select ok((select referral_rewarded_at is not null from members where id = :'e_first'::uuid), 'H3 標記重新寫上');

update members set points_balance = 0 where id = :'r_poor'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select revert_completed_booking(:'poor_id'::uuid, '首次推薦人沒錢') as r \gset poor_rv_
select pg_temp.test_clear_auth();
select ok((select referral_rewarded_at is not null from members where id = :'e_poor'::uuid),
  'H4 推薦人有差額 → 標記不清(v2.4 第 17 條)');
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select pg_temp.done(:'poor_id'::uuid);
select pg_temp.test_clear_auth();
select is(
  pg_temp.cnt(:'poor_id'::uuid, 'referral_bonus') || '/' || pg_temp.cnt(:'poor_id'::uuid, 'referral_repeat_bonus')
    || '/' || pg_temp.bal(:'r_poor'::uuid),
  '1/0/0',
  'H5 再完成不再發首次、也不改發後續(本單推薦淨額仍 20 > 0 擋住)');
select is(pg_temp.cnt(:'poor_id'::uuid, 'earn_booking'), 2, 'H6 被推薦人本身照常再入帳');

-- =========================================================================
-- I. get_member_related_bookings
-- =========================================================================
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select is(
  (select r.earned_points || '/' || r.reversed_points from get_member_related_bookings(:'m_topup'::uuid) r where r.id = :'topup_id'::uuid),
  '50/10',
  'I1 §4.8(核心):補差額後 earned_points = 有效入帳 50(不是任意一筆 50 或 10)、reversed_points = 10');
select is(
  (select r.earned_points || '/' || r.reversed_points from get_member_related_bookings(:'m_less'::uuid) r where r.id = :'less_id'::uuid),
  '40/10',
  'I2 邊界 21 那張:有效入帳 40、收回 10');
select is(
  (select r.earned_points || '/' || r.reversed_points from get_member_related_bookings(:'m_redo'::uuid) r where r.id = :'redo_id'::uuid),
  '50/50',
  'I3 完成 → 還原 → 再完成:有效入帳 50、曾收回 50');
select is(
  (select coalesce(r.earned_points::text, 'null') || '/' || r.reversed_points from get_member_related_bookings(:'m_redo'::uuid) r where r.id = :'zero_id'::uuid),
  'null/0',
  'I4 從未入帳(派 0 點)⇒ earned_points 為 null、reversed_points 0');
select is(
  (select r.earned_points || '/' || r.reversed_points || '/' || r.status from get_member_related_bookings(:'m_new'::uuid) r where r.id = :'swap_id'::uuid),
  '0/50/cancelled',
  'I5 取消後:有效入帳 0、收回 50(只算本會員,不混入舊會員的差額)');
select pg_temp.test_clear_auth();
select ok(
  not has_function_privilege('anon', 'public.get_member_related_bookings(uuid)', 'execute')
  and not has_function_privilege('public', 'public.get_member_related_bookings(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_member_related_bookings(uuid)', 'execute'),
  'I6 drop/create 後權限補回:PUBLIC / anon 不能執行、authenticated 可以');
select set_config('request.jwt.claims', '', true);
set local role anon;
select throws_ok(
  format($$select * from get_member_related_bookings('%s')$$, :'m_topup'),
  '42501', null, 'I7 anon 直接呼叫被擋');
reset role;

-- =========================================================================
-- J. render_booking_notification_variables
-- =========================================================================
select is(public.render_booking_notification_variables(:'topup_id'::uuid, 'e8440000-0000-4000-8000-000000000321'::uuid) ->> 'points_earned', '50',
  'J1 §4.8(核心):補差額後 LINE「訂單完成」的 {{points_earned}} = 有效入帳 50,不是最後一筆的 10');
select is(public.render_booking_notification_variables(:'less_id'::uuid, 'e8440000-0000-4000-8000-000000000321'::uuid) ->> 'points_earned', '40',
  'J2 邊界 21 那張 = 40');
select is(public.render_booking_notification_variables(:'redo_id'::uuid, 'e8440000-0000-4000-8000-000000000321'::uuid) ->> 'points_earned', '50',
  'J3 完成 → 還原 → 再完成 = 50');
select is(public.render_booking_notification_variables(:'swap_id'::uuid, 'e8440000-0000-4000-8000-000000000321'::uuid) ->> 'points_earned', '',
  'J4 取消後全額收回 ⇒ 空字串(跟沒有入帳一樣)');
select is(public.render_booking_notification_variables(:'zero_id'::uuid, 'e8440000-0000-4000-8000-000000000321'::uuid) ->> 'points_earned', '',
  'J5 從未入帳 ⇒ 空字串');

-- =========================================================================
-- K. 既有行為(complete_booking 改了一個字之後)
-- =========================================================================
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000301');
select throws_ok(format($$select complete_booking('%s')$$, :'topup_id'),
  'P0001', '只有「已接受」狀態的預約可以標記完成，目前狀態不允許這個操作',
  'K1 已完成的單再按完成 → 同一句錯誤訊息(邊界 22 第二個人看到的就是這句)');
select is(
  (select count(*)::int from booking_status_change_logs where booking_id = :'topup_id'::uuid and to_status = 'completed'),
  2, 'K2 補差額那張:完成兩次 = 兩筆「→ 已完成」操作紀錄(每次完成各一筆,不多不少)');
select is(
  (select count(*)::int from booking_commission_records where booking_id = :'topup_id'::uuid),
  1, 'K3 抽成快照仍是 1 筆(還原刪掉舊的、再完成寫新的)');
select pg_temp.test_clear_auth();

select * from finish();
rollback;
