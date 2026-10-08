-- 客戶端第 4-A 批 — 客人自己取消(C4-D01、D02、D04、F03)
-- 規格書 .project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」Q1 = A:店家建的單也能取消)
--
--   D01  customer_can_cancel:期限前 1 秒可以、期限當下不行、N = 0、N = 48、每種狀態;Q1 = A 後台單也可以
--   D02  internal_customer_cancel_booking 每個分支:unavailable / not_linked / not_found(不存在、別人的、別家店)/
--        already_cancelled(冪等、不重發鈴鐺)/ deadline_passed / not_cancellable / cancelled
--        成功後:訂單欄位、操作紀錄、退回紅利折抵、_internal 推播文字、回傳 BookingView
--        🔴 與後台 cancel_booking 對照:同樣的兩張單,一張後台取消、一張客人取消,訂單欄位(除操作人 / 原因 / 時間)、
--           紅利分類帳、餘額結果相同
--   D04  鈴鐺收件人(管理員、orders 客服、通過行事曆門檻的服務人員;同帳號一則;沒權限的客服 / 沒開通的服務人員不收)與文字
--   並發:pgTAP 只有一條連線,無法真的開兩個交易;另以兩條 psql 連線手動驗證(見回報)。
begin;

select plan(58);

create function pg_temp.as_user(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;
create function pg_temp.as_postgres()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
grant execute on function pg_temp.as_postgres() to authenticated;

create temp table c4c_out (label text, body jsonb);
create function pg_temp.cx(p_label text, p_slug text, p_user uuid, p_booking uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  v := public.internal_customer_cancel_booking(p_slug, p_user, p_booking);
  insert into c4c_out values (p_label, v);
  return v;
end $$;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c4c00000-0000-4000-8000-000000000001', 'pgtap-c4c-admin@test.local', '{}'::jsonb),
  ('c4c00000-0000-4000-8000-000000000002', 'pgtap-c4c-agent-orders@test.local', '{}'::jsonb),
  ('c4c00000-0000-4000-8000-000000000003', 'pgtap-c4c-agent-noorders@test.local', '{}'::jsonb),
  ('c4c00000-0000-4000-8000-000000000004', 'pgtap-c4c-staff@test.local', '{}'::jsonb),
  ('c4c00000-0000-4000-8000-000000000005', 'pgtap-c4c-staff-noview@test.local', '{}'::jsonb),
  ('c4c00000-0000-4000-8000-000000000011', 'line-c4c-11@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4c00000-0000-4000-8000-000000000012', 'line-c4c-12@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4c00000-0000-4000-8000-000000000015', 'pgtap-c4c-not-customer@test.local', '{}'::jsonb);

insert into groups (id) values ('c4c00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c4c00000-0000-4000-8000-000000000021', 'c4c00000-0000-4000-8000-000000000091', 'C4取消店', 'in_store_beauty', 'pgtap-c4c-shop', 'active'),
  ('c4c00000-0000-4000-8000-000000000022', 'c4c00000-0000-4000-8000-000000000091', 'C4取消別家', 'in_store_beauty', 'pgtap-c4c-other', 'active'),
  ('c4c00000-0000-4000-8000-000000000023', 'c4c00000-0000-4000-8000-000000000091', 'C4取消停用', 'in_store_beauty', 'pgtap-c4c-off', 'disabled');
insert into merchant_admins (merchant_id, user_id) values
  ('c4c00000-0000-4000-8000-000000000021', 'c4c00000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c4c00000-0000-4000-8000-000000000071', 'c4c00000-0000-4000-8000-000000000021', 'c4c00000-0000-4000-8000-000000000002', 'C4客服訂單', '0900500071', 'pgtap-c4c-agent-orders@test.local', 'active'),
  ('c4c00000-0000-4000-8000-000000000072', 'c4c00000-0000-4000-8000-000000000021', 'c4c00000-0000-4000-8000-000000000003', 'C4客服無權', '0900500072', 'pgtap-c4c-agent-noorders@test.local', 'active'),
  ('c4c00000-0000-4000-8000-000000000073', 'c4c00000-0000-4000-8000-000000000021', 'c4c00000-0000-4000-8000-000000000001', 'C4管理員兼客服', '0900500073', 'pgtap-c4c-admin@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c4c00000-0000-4000-8000-000000000071', 'orders', true),
  ('c4c00000-0000-4000-8000-000000000073', 'orders', true);

insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c4c00000-0000-4000-8000-000000000021', '4545454545', vault.create_secret('C4CFAKESECRET00000000000000000AA'), '00AA', true),
  ('c4c00000-0000-4000-8000-000000000023', '4646464646', vault.create_secret('C4CFAKESECRET00000000000000000BB'), '00BB', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name) values
  ('c4c00000-0000-4000-8000-000000000011', '4545454545', 'U-c4c-11', 'LINE小明'),
  ('c4c00000-0000-4000-8000-000000000012', '4545454545', 'U-c4c-12', 'LINE別人');

insert into merchant_staff (id, merchant_id, name, nickname, phone, is_listed, status, user_id, login_status) values
  ('c4c00000-0000-4000-8000-000000000031', 'c4c00000-0000-4000-8000-000000000021', '陳大明', '阿明', '0900500031', true, 'active', 'c4c00000-0000-4000-8000-000000000004', 'active'),
  ('c4c00000-0000-4000-8000-000000000032', 'c4c00000-0000-4000-8000-000000000021', '林小美', null, '0900500032', true, 'active', 'c4c00000-0000-4000-8000-000000000005', 'active'),
  ('c4c00000-0000-4000-8000-000000000033', 'c4c00000-0000-4000-8000-000000000022', '別家人員', null, '0900500033', true, 'active', null, 'not_invited');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('c4c00000-0000-4000-8000-000000000031', 'staff_calendar_view', true);

insert into members (id, merchant_id, name, phone, referral_code, user_id, points_balance) values
  ('c4c00000-0000-4000-8000-000000000041', 'c4c00000-0000-4000-8000-000000000021', E'王小明\n', '0912500041', 'C4CREF41', 'c4c00000-0000-4000-8000-000000000011', 300),
  ('c4c00000-0000-4000-8000-000000000042', 'c4c00000-0000-4000-8000-000000000021', '別的會員', '0912500042', 'C4CREF42', 'c4c00000-0000-4000-8000-000000000012', 0),
  ('c4c00000-0000-4000-8000-000000000043', 'c4c00000-0000-4000-8000-000000000022', '別家會員', '0912500043', 'C4CREF43', null, 0);
-- 第 4-B 批:接上 = 聯絡人表(members.user_id = 主要聯絡人)。直接寫 user_id 的 fixture 同步補主要聯絡人列。
insert into member_customer_contacts (merchant_id, member_id, user_id, is_primary, joined_via)
select merchant_id, id, user_id, true, 'backfill' from members
where user_id is not null and id in ('c4c00000-0000-4000-8000-000000000041', 'c4c00000-0000-4000-8000-000000000042', 'c4c00000-0000-4000-8000-000000000043');

create temp table c4c_b (k text primary key, id uuid);
grant select on c4c_b to authenticated;
create function pg_temp.mk(p_k text, p_member uuid, p_start timestamptz, p_status text, p_source text default 'manual',
                           p_staff uuid default 'c4c00000-0000-4000-8000-000000000031', p_redeem integer default 0)
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source,
                        member_id, notes, final_amount_snapshot, points_redeemed, points_redeem_amount_snapshot, points_planned)
  values ((select merchant_id from members where id = p_member), p_staff, p_start, p_start + interval '1 hour',
          '王小明', '0912500041', case when p_source = 'customer' then 'customer' else 'admin' end, p_status, p_source,
          p_member, '內部備註', 1500, p_redeem, p_redeem, 30)
  returning id into v;
  insert into c4c_b values (p_k, v);
  return v;
end $$;

select pg_temp.mk('ok_admin', 'c4c00000-0000-4000-8000-000000000041', now() + interval '3 days', 'accepted');
select pg_temp.mk('ok_cust', 'c4c00000-0000-4000-8000-000000000041', now() + interval '3 days 2 hours', 'pending_confirmation', 'customer');
select pg_temp.mk('late', 'c4c00000-0000-4000-8000-000000000041', now() + interval '23 hours', 'accepted');
select pg_temp.mk('done', 'c4c00000-0000-4000-8000-000000000041', now() + interval '4 days', 'completed');
select pg_temp.mk('pr', 'c4c00000-0000-4000-8000-000000000041', now() + interval '4 days 2 hours', 'pending_reply');
select pg_temp.mk('already', 'c4c00000-0000-4000-8000-000000000041', now() + interval '5 days', 'cancelled');
select pg_temp.mk('pr2', 'c4c00000-0000-4000-8000-000000000042', now() + interval '8 days', 'pending_confirmation');
select pg_temp.mk('others', 'c4c00000-0000-4000-8000-000000000042', now() + interval '3 days', 'accepted');
select pg_temp.mk('othershop', 'c4c00000-0000-4000-8000-000000000043', now() + interval '3 days', 'accepted', 'manual', 'c4c00000-0000-4000-8000-000000000033');
-- 對照組:兩張一模一樣、各折抵 100 點的單(會員原本 500,兩次折抵後 300)
select pg_temp.mk('cmp_admin', 'c4c00000-0000-4000-8000-000000000041', now() + interval '6 days', 'accepted', 'manual', 'c4c00000-0000-4000-8000-000000000032', 100);
select pg_temp.mk('cmp_cust', 'c4c00000-0000-4000-8000-000000000041', now() + interval '6 days', 'accepted', 'manual', 'c4c00000-0000-4000-8000-000000000032', 100);
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note) values
  ('c4c00000-0000-4000-8000-000000000041', 'c4c00000-0000-4000-8000-000000000021', 'redeem_booking', -100, 400, (select id from c4c_b where k = 'cmp_admin'), 'x'),
  ('c4c00000-0000-4000-8000-000000000041', 'c4c00000-0000-4000-8000-000000000021', 'redeem_booking', -100, 300, (select id from c4c_b where k = 'cmp_cust'), 'x');

-- =========================================================================
-- D01 customer_can_cancel
-- =========================================================================
create function pg_temp.can(p_k text, p_now timestamptz) returns boolean language sql stable as $$
  select private.customer_can_cancel(b, p_now) from bookings b where b.id = (select id from c4c_b where k = p_k)
$$;
create function pg_temp.st(p_k text) returns timestamptz language sql stable as $$
  select start_at from bookings where id = (select id from c4c_b where k = p_k)
$$;
select is(pg_temp.can('ok_admin', pg_temp.st('ok_admin') - interval '24 hours' - interval '1 second'), true, 'D01-1 期限前 1 秒可以');
select is(pg_temp.can('ok_admin', pg_temp.st('ok_admin') - interval '24 hours'), false, 'D01-2 期限當下不行');
select is(pg_temp.can('done', pg_temp.st('done') - interval '3 days'), false, 'D01-3 已完成不行');
select is(pg_temp.can('already', pg_temp.st('already') - interval '3 days'), false, 'D01-4 已取消不行');
select is(pg_temp.can('pr', pg_temp.st('pr') - interval '3 days'), false, 'D01-5 pending_reply 不行(同後台 cancel_booking)');
select is(pg_temp.can('ok_cust', pg_temp.st('ok_cust') - interval '3 days'), true, 'D01-6 待確認可以');
select is(pg_temp.can('ok_admin', pg_temp.st('ok_admin') - interval '3 days'), true, 'D01-7 Q1 = A:後台建的單(source manual)也可以');
insert into merchant_booking_settings (merchant_id, customer_cancel_deadline_hours) values ('c4c00000-0000-4000-8000-000000000021', 0);
select is(pg_temp.can('late', pg_temp.st('late') - interval '1 second'), true, 'D01-8 N = 0:開始前 1 秒還可以');
select is(pg_temp.can('late', pg_temp.st('late')), false, 'D01-9 N = 0:開始當下不行');
update merchant_booking_settings set customer_cancel_deadline_hours = 48 where merchant_id = 'c4c00000-0000-4000-8000-000000000021';
select is(pg_temp.can('ok_admin', pg_temp.st('ok_admin') - interval '47 hours'), false, 'D01-10 N = 48:開始前 47 小時不行');
delete from merchant_booking_settings where merchant_id = 'c4c00000-0000-4000-8000-000000000021';

-- =========================================================================
-- D02 分支
-- =========================================================================
select is(pg_temp.cx('off', 'pgtap-c4c-off', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'ok_admin')),
          '{"state": "unavailable"}'::jsonb, 'D02-1 店家停用 ⇒ unavailable');
select is(pg_temp.cx('nouser', 'pgtap-c4c-shop', null, (select id from c4c_b where k = 'ok_admin')),
          '{"state": "not_linked"}'::jsonb, 'D02-2 沒有使用者 ⇒ not_linked');
select is(pg_temp.cx('notcust', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000015', (select id from c4c_b where k = 'ok_admin')),
          '{"state": "not_linked"}'::jsonb, 'D02-3 不是客人帳號 ⇒ not_linked');
select is(pg_temp.cx('wrongshop', 'pgtap-c4c-other', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'othershop')),
          '{"state": "unavailable"}'::jsonb, 'D02-4 別家店沒啟用 LINE 登入 ⇒ unavailable');
select is(pg_temp.cx('nf1', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', gen_random_uuid()),
          '{"state": "not_found"}'::jsonb, 'D02-5 不存在的單 ⇒ not_found');
select is(pg_temp.cx('nf2', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'others')),
          '{"state": "not_found"}'::jsonb, 'D02-6 別人的單 ⇒ not_found(同一句,F03)');
select is(pg_temp.cx('nf3', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'othershop')),
          '{"state": "not_found"}'::jsonb, 'D02-7 別家店的單 ⇒ not_found');
select is(pg_temp.cx('nf4', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', null),
          '{"state": "not_found"}'::jsonb, 'D02-8 booking_id null ⇒ not_found');
select is((select status from bookings where id = (select id from c4c_b where k = 'others')), 'accepted', 'D02-9 別人的單沒有被動到');
select is(pg_temp.cx('late', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'late')),
          '{"state": "deadline_passed"}'::jsonb, 'D02-10 過了期限 ⇒ deadline_passed');
select is(pg_temp.cx('done', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'done')),
          '{"state": "not_cancellable"}'::jsonb, 'D02-11 已完成 ⇒ not_cancellable');
select is(pg_temp.cx('pr', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'pr')),
          '{"state": "not_cancellable"}'::jsonb, 'D02-12 pending_reply ⇒ not_cancellable');
select is(pg_temp.cx('already', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'already')),
          '{"state": "already_cancelled"}'::jsonb, 'D02-13 已取消 ⇒ already_cancelled');
select is((select count(*)::integer from user_notifications where merchant_id = 'c4c00000-0000-4000-8000-000000000021'), 0,
          'D02-14 以上失敗分支都沒有發鈴鐺');

-- 成功(後台建的已確認單)
select pg_temp.cx('ok', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'ok_admin'));
select is((select body ->> 'state' from c4c_out where label = 'ok'), 'cancelled', 'D02-15 成功 ⇒ cancelled');
select is((select row(body -> 'booking' ->> 'id', body -> 'booking' ->> 'status', body -> 'booking' ->> 'can_cancel',
                      body -> 'booking' -> 'cancel_deadline_at', (body -> 'booking' ->> 'cancelled_at') is not null)::text from c4c_out where label = 'ok'),
          row((select id::text from c4c_b where k = 'ok_admin'), 'cancelled', 'false', 'null'::jsonb, true)::text,
          'D02-16 回傳 BookingView:已取消、不能再取消、沒有期限、有取消時間');
select is((select array_agg(k order by k) from c4c_out, jsonb_object_keys(body -> '_internal') k where label = 'ok'),
          array['booking_id', 'merchant_id', 'push_body', 'push_title'], 'D02-17 _internal 有推播需要的欄位(Edge 一定要刪)');
select is((select row(b.status, b.cancelled_reason, b.last_modified_by_user_id, b.cancelled_at is not null, b.last_modified_at is not null)::text
           from bookings b where b.id = (select id from c4c_b where k = 'ok_admin')),
          row('cancelled', '客人線上取消', 'c4c00000-0000-4000-8000-000000000011'::uuid, true, true)::text,
          'D02-18 訂單欄位:狀態、原因、最後修改人 / 時間、取消時間');
select is((select row(l.from_status, l.to_status, l.actor_user_id, l.actor_role_snapshot, l.actor_name_snapshot)::text
           from booking_status_change_logs l where l.booking_id = (select id from c4c_b where k = 'ok_admin')),
          row('accepted', 'cancelled', 'c4c00000-0000-4000-8000-000000000011'::uuid, 'customer', '客人 王小明')::text,
          'D02-19 操作紀錄:角色 customer、「客人 會員姓名」(姓名換行換成空白、去頭尾空白)');
select is(pg_temp.cx('again', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'ok_admin')),
          '{"state": "already_cancelled"}'::jsonb, 'D02-20 重按 ⇒ already_cancelled');

-- =========================================================================
-- D04 鈴鐺
-- =========================================================================
select is((select array_agg(target_type || ':' || user_id::text order by target_type, user_id) from user_notifications
           where booking_id = (select id from c4c_b where k = 'ok_admin')),
          array['admin:c4c00000-0000-4000-8000-000000000001', 'agent:c4c00000-0000-4000-8000-000000000002', 'staff:c4c00000-0000-4000-8000-000000000004'],
          'D04-1 收件人:管理員(兼客服只一則)、orders 客服、通過行事曆門檻的服務人員;重按沒有重發');
select is((select array_agg(distinct event_type) from user_notifications where booking_id = (select id from c4c_b where k = 'ok_admin')),
          array['customer_booking_cancelled'], 'D04-2 事件 customer_booking_cancelled');
select is((select array_agg(distinct title || '|' || body) from user_notifications where booking_id = (select id from c4c_b where k = 'ok_admin')),
          array['客人取消了預約|客人「王小明」取消了 ' || to_char(pg_temp.st('ok_admin') at time zone 'Asia/Taipei', 'FMMM/FMDD') || '（'
                || (array['日', '一', '二', '三', '四', '五', '六'])[extract(dow from pg_temp.st('ok_admin') at time zone 'Asia/Taipei')::integer + 1]
                || '）' || to_char(pg_temp.st('ok_admin') at time zone 'Asia/Taipei', 'HH24:MI') || ' 的預約，服務人員：陳大明。'],
          'D04-3 文字(服務人員用本名、姓名去換行、不放電話金額)');
select is((select body -> '_internal' ->> 'push_body' from c4c_out where label = 'ok'),
          (select body from user_notifications where booking_id = (select id from c4c_b where k = 'ok_admin') limit 1),
          'D04-4 推播文字 = 鈴鐺同一套');
select pg_temp.cx('cust', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'ok_cust'));
select is((select array_agg(target_type order by target_type) from user_notifications where booking_id = (select id from c4c_b where k = 'ok_cust')),
          array['admin', 'agent', 'staff'], 'D04-5 客人線上下的待確認單也能取消、一樣通知');
select pg_temp.cx('cmp', 'pgtap-c4c-shop', 'c4c00000-0000-4000-8000-000000000011', (select id from c4c_b where k = 'cmp_cust'));
select is((select array_agg(target_type order by target_type) from user_notifications where booking_id = (select id from c4c_b where k = 'cmp_cust')),
          array['admin', 'agent'], 'D04-6 服務人員沒有行事曆檢視權限 ⇒ 不收(#876)');

-- =========================================================================
-- D02 與後台 cancel_booking 對照
-- =========================================================================
select pg_temp.as_user('c4c00000-0000-4000-8000-000000000001');
select (public.cancel_booking((select id from c4c_b where k = 'cmp_admin'), '客人線上取消')).id;
select pg_temp.as_postgres();
select is((select to_jsonb(b) - array['id', 'last_modified_by_user_id', 'last_modified_at', 'cancelled_at', 'updated_at', 'created_at', 'cancelled_reason']
           from bookings b where b.id = (select id from c4c_b where k = 'cmp_cust')),
          (select to_jsonb(b) - array['id', 'last_modified_by_user_id', 'last_modified_at', 'cancelled_at', 'updated_at', 'created_at', 'cancelled_reason']
           from bookings b where b.id = (select id from c4c_b where k = 'cmp_admin')),
          'D02-21 對照:客人取消與後台取消,訂單其他欄位全部相同(含折抵歸 0)');
select is((select array_agg(row(t.transaction_type, t.points_delta, t.member_id)::text order by t.transaction_type, t.points_delta)
           from member_point_transactions t where t.booking_id = (select id from c4c_b where k = 'cmp_cust')),
          (select array_agg(row(t.transaction_type, t.points_delta, t.member_id)::text order by t.transaction_type, t.points_delta)
           from member_point_transactions t where t.booking_id = (select id from c4c_b where k = 'cmp_admin')),
          'D02-22 對照:紅利分類帳相同(各一筆 redeem_booking −100 + redeem_booking_refund +100)');
select is((select points_balance from members where id = 'c4c00000-0000-4000-8000-000000000041'), 500, 'D02-23 對照:兩張都退回後餘額回到 500');
select is((select row(b.points_redeemed, b.points_redeem_amount_snapshot, b.points_planned)::text from bookings b where b.id = (select id from c4c_b where k = 'cmp_cust')),
          row(0, 0::numeric(12,2), 30)::text, 'D02-24 客人取消:折抵歸 0、預計派點保留(不入帳)');
select is((select count(*)::integer from booking_status_change_logs l where l.booking_id in (select id from c4c_b where k in ('cmp_cust', 'cmp_admin'))), 2,
          'D02-25 兩邊各一筆操作紀錄');
select is((select count(*)::integer from member_point_transactions where member_id = 'c4c00000-0000-4000-8000-000000000041' and transaction_type like 'earn%'), 0,
          'D02-26 取消不派點');
select is((select count(*)::integer from c4c_out where body::text like '%內部備註%' or body::text like '%0912500041%'
             or body::text like '%c4c00000-0000-4000-8000-000000000041%'), 0,
          'D02-27 回應搜不到內部備註、電話、member_id(F02)');

-- =========================================================================
-- 主腦裁決 (a):confirm_booking 並發修正(migration 20261010100200)
--   已取消 / 已完成的單呼叫 confirm_booking ⇒ 原本的錯誤路徑擋下、狀態不變;函式本體有 for update 與狀態條件(防回歸)。
--   真並發(客人先取消 → 店家確認)pgTAP 只有一條連線做不到,另以兩條 psql 連線重現(見回報)。
-- =========================================================================
select pg_temp.as_user('c4c00000-0000-4000-8000-000000000001');
select throws_ok(format('select public.confirm_booking(%L)', (select id from c4c_b where k = 'ok_admin')),
  'P0001', '只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：cancelled)',
  'LOCK-1 客人已取消的單,店家按確認 ⇒ 原本的錯誤訊息擋下');
select throws_ok(format('select public.confirm_booking(%L)', (select id from c4c_b where k = 'done')),
  'P0001', '只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：completed)',
  'LOCK-2 已完成的單按確認 ⇒ 擋下');
select pg_temp.as_postgres();
select is((select status from bookings where id = (select id from c4c_b where k = 'ok_admin')), 'cancelled', 'LOCK-3 狀態仍是 cancelled');
select is((select count(*)::integer from booking_status_change_logs where booking_id = (select id from c4c_b where k = 'ok_admin') and to_status = 'accepted'), 0,
  'LOCK-4 沒有寫出「改成已確認」的操作紀錄');
select ok((select prosrc ~ 'where id = p_booking_id\s+for update;' and prosrc ~ 'and status = ''pending_confirmation''\s+returning'
           from pg_proc where oid = 'public.confirm_booking(uuid)'::regprocedure),
  'LOCK-5 confirm_booking 讀取有 for update、UPDATE 有狀態條件(防回歸)');
select pg_temp.as_user('c4c00000-0000-4000-8000-000000000001');
select is((public.confirm_booking((select id from c4c_b where k = 'pr2'))).status, 'accepted', 'LOCK-6 正常待確認單照樣可以確認');
select pg_temp.as_postgres();

-- =========================================================================
-- 主腦裁決:move_booking、update_booking_payment_method 並發修正(migration 20261010100300)
--   已取消 / 已完成的單 ⇒ 兩支都走原本錯誤路徑、資料沒被改、沒寫操作紀錄;函式本體 for update + 狀態條件(防回歸);正常單照常可用。
-- =========================================================================
create temp table c4c_snap as select id, start_at, end_at, staff_id, payment_method_id, last_modified_at, status,
  (select count(*) from booking_status_change_logs l where l.booking_id = b.id) as log_count from bookings b
  where id in (select id from c4c_b where k in ('ok_admin', 'done'));
select pg_temp.as_user('c4c00000-0000-4000-8000-000000000001');
select throws_ok(format('select public.move_booking(%L, %L, %L, %L, %L, %L)',
    (select id from c4c_b where k = 'ok_admin'), 'c4c00000-0000-4000-8000-000000000031', 'c4c00000-0000-4000-8000-000000000031',
    pg_temp.st('ok_admin') + interval '1 hour', pg_temp.st('ok_admin'), 'c4c00000-0000-4000-8000-000000000031'),
  'P0001', '已完成或已取消的預約不能移動', 'LOCK2-1 已取消的單拖拉改時間 ⇒ 擋下');
select throws_ok(format('select public.move_booking(%L, %L, %L, %L, %L, %L)',
    (select id from c4c_b where k = 'done'), 'c4c00000-0000-4000-8000-000000000031', 'c4c00000-0000-4000-8000-000000000031',
    pg_temp.st('done') + interval '1 hour', pg_temp.st('done'), 'c4c00000-0000-4000-8000-000000000031'),
  'P0001', '已完成或已取消的預約不能移動', 'LOCK2-2 已完成的單拖拉 ⇒ 擋下');
select throws_ok(format('select public.update_booking_payment_method(%L, null)', (select id from c4c_b where k = 'ok_admin')),
  'P0001', '已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：cancelled)', 'LOCK2-3 已取消的單改付款方式 ⇒ 擋下');
select throws_ok(format('select public.update_booking_payment_method(%L, null)', (select id from c4c_b where k = 'done')),
  'P0001', '已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：completed)', 'LOCK2-4 已完成的單改付款方式 ⇒ 擋下');
select pg_temp.as_postgres();
select is((select count(*)::integer from bookings b join c4c_snap s on s.id = b.id
           where (b.start_at, b.end_at, b.staff_id, b.payment_method_id, b.last_modified_at, b.status)
                 is not distinct from (s.start_at, s.end_at, s.staff_id, s.payment_method_id, s.last_modified_at, s.status)), 2,
  'LOCK2-5 兩張單的時間、服務人員、付款方式、最後修改時間、狀態都沒變');
select is((select count(*)::integer from c4c_snap s where (select count(*) from booking_status_change_logs l where l.booking_id = s.id) <> s.log_count), 0,
  'LOCK2-6 沒有新的操作紀錄');
select ok((select bool_and(prosrc ~ 'where id = p_booking_id\s+for update;') and bool_and(prosrc ~ 'and status in \(''pending_confirmation'', ''accepted''\)')
           from pg_proc where oid in ('public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid)'::regprocedure,
                                      'public.update_booking_payment_method(uuid, uuid)'::regprocedure)),
  'LOCK2-7 兩支函式讀取有 for update、UPDATE 有狀態條件(防回歸)');
select is((select array_length(regexp_split_to_array(prosrc, 'and status in \(''pending_confirmation'', ''accepted''\)'), 1) - 1
           from pg_proc where oid = 'public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid)'::regprocedure), 2,
  'LOCK2-8 move_booking 兩個 UPDATE(主服務人員 / 助手色塊)都有狀態條件');
select pg_temp.as_user('c4c00000-0000-4000-8000-000000000001');
select is((public.update_booking_payment_method((select id from c4c_b where k = 'pr2'), null)).status, 'accepted',
  'LOCK2-9 正常單(LOCK-6 確認後的已確認單)照常可以改付款方式');
select pg_temp.as_postgres();

select * from finish();
rollback;
