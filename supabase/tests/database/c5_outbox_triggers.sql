-- 客戶端第 5-A 批 — 資料表、待發清單寫入口、bookings trigger(C5-A01~A05、S01、S02、S06、N01~N06、N04 合併、N05 補充)
-- 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md(零之零定案優先)
--
--   A01~A05  新表 RLS / 0 policy / 沒有表權限、預設值、check(舊值仍可寫、新值可寫、亂值被拒)、唯一索引
--   S01      店沒接上 ⇒ 0 列;開關關 ⇒ 0 列;停發中 ⇒ 0 列;故意讓寫入失敗 ⇒ 訂單更新照樣成功
--   S02      每種事件 × 每種做的人;服務人員改時間不寫(GUC 與帳號兩種判斷);只換服務人員不寫;匯入不寫;沒會員只寫店家那筆
--   N04      改時間合併(只把 send_after 往後延、old_start_at 保留第一次)
--   N05      已完成的單被取消:trigger 不發;cancel_completed_booking 勾通知才發
--   S06      客人送出 / 自己取消 ⇒ 店家那邊一筆(看模組 11 事件設定)
--   actor    booking_actor_kind 各分支
begin;

select plan(85);

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
grant execute on function pg_temp.as_user(uuid) to anon, authenticated, service_role;
grant execute on function pg_temp.as_postgres() to anon, authenticated, service_role;

create function pg_temp.err(p_sql text)
returns text language plpgsql as $$
declare v_hint text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return sqlstate || ':' || coalesce(v_hint, '');
end $$;
grant execute on function pg_temp.err(text) to anon, authenticated, service_role;

-- 某張單目前的待發種類(排序後)
create function pg_temp.kinds(p_booking uuid)
returns text[] language sql as $$
  select coalesce(array_agg(kind order by kind), array[]::text[]) from public.customer_line_outbox where booking_id = p_booking
$$;

-- =========================================================================
-- Fixture:A 店已接上官方帳號、B 店沒接上
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c5a00000-0000-4000-8000-000000000001', 'pgtap-c5a-admin@test.local', '{}'::jsonb),
  ('c5a00000-0000-4000-8000-000000000002', 'pgtap-c5a-agent@test.local', '{}'::jsonb),
  ('c5a00000-0000-4000-8000-000000000003', 'pgtap-c5a-staff@test.local', '{}'::jsonb),
  ('c5a00000-0000-4000-8000-000000000004', 'pgtap-c5a-groupadmin@test.local', '{}'::jsonb),
  ('c5a00000-0000-4000-8000-000000000005', 'pgtap-c5a-staffadmin@test.local', '{}'::jsonb),
  ('c5a00000-0000-4000-8000-000000000011', 'line-pgtap-c5a-11@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c5a00000-0000-4000-8000-000000000012', 'line-pgtap-c5a-12@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb);

insert into groups (id, group_admin_user_id) values ('c5a00000-0000-4000-8000-000000000091', 'c5a00000-0000-4000-8000-000000000004');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000091', 'C5A接上店', 'in_store_beauty', 'pgtap-c5a-on', 'active'),
  ('c5a00000-0000-4000-8000-000000000032', 'c5a00000-0000-4000-8000-000000000091', 'C5A沒接店', 'in_store_beauty', 'pgtap-c5a-off', 'active');
insert into merchant_admins (merchant_id, user_id) values
  ('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000001'),
  ('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000005'),
  ('c5a00000-0000-4000-8000-000000000032', 'c5a00000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c5a00000-0000-4000-8000-000000000071', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000002', 'C5A客服', '0900510071', 'pgtap-c5a-agent@test.local', 'active');
insert into merchant_staff (id, merchant_id, name, status, login_status, phone, user_id) values
  ('c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000031', 'C5A服務人員', 'active', 'not_invited', '0900510051', 'c5a00000-0000-4000-8000-000000000003'),
  ('c5a00000-0000-4000-8000-000000000052', 'c5a00000-0000-4000-8000-000000000031', 'C5A店長兼服務人員', 'active', 'not_invited', '0900510052', 'c5a00000-0000-4000-8000-000000000005'),
  ('c5a00000-0000-4000-8000-000000000053', 'c5a00000-0000-4000-8000-000000000032', 'C5B服務人員', 'active', 'not_invited', '0900510053', null);

insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected) values
  ('c5a00000-0000-4000-8000-000000000031', '1234567890', 'C5A-SECRET-SENTINEL', 'C5A-TOKEN-SENTINEL', true),
  ('c5a00000-0000-4000-8000-000000000032', '1234567891', 'C5B-SECRET-SENTINEL', 'C5B-TOKEN-SENTINEL', false);
insert into merchant_line_event_settings (merchant_id, event_type, enabled, notify_admin, notify_agent, notify_staff, notify_member, message_template) values
  ('c5a00000-0000-4000-8000-000000000031', 'booking_created', true, true, false, false, true, '新預約'),
  ('c5a00000-0000-4000-8000-000000000031', 'booking_cancelled', true, true, false, false, true, '取消');

insert into members (id, merchant_id, name, phone, referral_code) values
  ('c5a00000-0000-4000-8000-000000000041', 'c5a00000-0000-4000-8000-000000000031', 'C5A會員', '0912510001', 'C5AREF41'),
  ('c5a00000-0000-4000-8000-000000000042', 'c5a00000-0000-4000-8000-000000000032', 'C5B會員', '0912510002', 'C5AREF42');

-- 訂單:helper 直接 insert(trigger 只看欄位,不看是哪支函式寫的;真函式另外測)
create function pg_temp.mk(p_id text, p_merchant uuid, p_staff uuid, p_member uuid, p_source text, p_role text, p_by uuid,
                           p_status text, p_guest boolean default false)
returns uuid language plpgsql as $$
declare v uuid := ('c5a00000-0000-4000-8000-0000000' || p_id)::uuid;
begin
  insert into public.bookings (id, merchant_id, staff_id, member_id, start_at, end_at, customer_name, customer_phone,
                               source, created_by_role, created_by_user_id, status, is_guest_booking, completed_at)
  values (v, p_merchant, p_staff, p_member, now() + interval '3 days', now() + interval '3 days 1 hour', '客人', '0912510001',
          p_source, p_role, p_by, p_status, p_guest, case when p_status = 'completed' then now() end);
  return v;
end $$;

-- =========================================================================
-- A01~A05 資料表
-- =========================================================================
select is((select array_agg(c.relname::text order by c.relname) from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
             and c.relname in ('merchant_customer_line_settings', 'customer_line_friendships', 'customer_line_outbox')),
          array['customer_line_friendships', 'customer_line_outbox', 'merchant_customer_line_settings'],
          'A-1 三張新表都開 RLS');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
           where c.relname in ('merchant_customer_line_settings', 'customer_line_friendships', 'customer_line_outbox')),
          0, 'A-2 三張新表 0 policy');
select is((select count(*)::int from information_schema.role_table_grants
           where table_schema = 'public' and grantee in ('anon', 'authenticated')
             and table_name in ('merchant_customer_line_settings', 'customer_line_friendships', 'customer_line_outbox')),
          0, 'A-3 anon / authenticated 對三張新表沒有任何表權限');
select is((select count(*)::int from pg_policy p join pg_roles r on r.oid = any (p.polroles) where r.rolname = 'anon'),
          0, 'X01 全庫 anon policy 仍為 0(鐵律 1)');

select is((select array_agg(column_name || '=' || column_default order by column_name) from information_schema.columns
           where table_schema = 'public' and table_name = 'member_customer_contacts' and column_name in ('notify_booking', 'notify_promo')),
          array['notify_booking=true', 'notify_promo=true'], 'A01-1 兩個開關預設開');
select is(left(pg_temp.err($$select pg_temp.as_user('c5a00000-0000-4000-8000-000000000011'); update public.member_customer_contacts set notify_booking = false$$), 6),
          '42501:', 'A01-2 authenticated 直接 update 聯絡人表被拒');
select pg_temp.as_postgres();

-- A02:沒有列時讀取函式的預設值 = 表的 column default
insert into merchant_customer_line_settings (merchant_id) values ('c5a00000-0000-4000-8000-000000000032');
select is(
  (select to_jsonb(s) - 'merchant_id' - 'created_at' - 'updated_at' from merchant_customer_line_settings s where merchant_id = 'c5a00000-0000-4000-8000-000000000032'),
  (select to_jsonb(private.customer_line_settings('c5a00000-0000-4000-8000-000000000031')) - 'merchant_id' - 'created_at' - 'updated_at'),
  'A02-1 沒有列 ⇒ 讀取函式回的預設值跟表的 column default 一模一樣(Q1=A)');
delete from merchant_customer_line_settings where merchant_id = 'c5a00000-0000-4000-8000-000000000032';
select is(pg_temp.err($$insert into merchant_customer_line_settings (merchant_id, reminder_hours_before) values ('c5a00000-0000-4000-8000-000000000032', 5)$$),
          '23514:', 'A02-2 reminder_hours_before 只收 2/3/6/12/24/48');
select is(pg_temp.err($$insert into merchant_customer_line_settings (merchant_id, monthly_cap) values ('c5a00000-0000-4000-8000-000000000032', 0)$$),
          '23514:', 'A02-3 monthly_cap 0 被拒(null 或 1~100000)');

-- A03:主鍵
insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at)
values ('c5a00000-0000-4000-8000-000000000031', 'U00000000000000000000000000000001', true, 'webhook', now());
select is(pg_temp.err($$insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at) values ('c5a00000-0000-4000-8000-000000000031', 'U00000000000000000000000000000001', false, 'login', now())$$),
          '23505:', 'A03-1 主鍵 (merchant_id, line_user_id)');
select is(pg_temp.err($$insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at) values ('c5a00000-0000-4000-8000-000000000031', 'U00000000000000000000000000000002', false, 'other', now())$$),
          '23514:', 'A03-2 source 只收 webhook / login');

-- A04:待發中同一個 dedupe_key 只會有一筆;結束後可以再寫
insert into customer_line_outbox (merchant_id, kind, dedupe_key) values ('c5a00000-0000-4000-8000-000000000031', 'customer_confirmed', 'pgtap-dup');
select is(pg_temp.err($$insert into customer_line_outbox (merchant_id, kind, dedupe_key) values ('c5a00000-0000-4000-8000-000000000031', 'customer_confirmed', 'pgtap-dup')$$),
          '23505:', 'A04-1 待發中同一個 dedupe_key 只能一筆');
update customer_line_outbox set status = 'sent' where dedupe_key = 'pgtap-dup';
select is(pg_temp.err($$insert into customer_line_outbox (merchant_id, kind, dedupe_key) values ('c5a00000-0000-4000-8000-000000000031', 'customer_confirmed', 'pgtap-dup')$$),
          'ok', 'A04-2 前一筆已送出 ⇒ 同 key 可以再寫');
select is(pg_temp.err($$insert into customer_line_outbox (merchant_id, kind) values ('c5a00000-0000-4000-8000-000000000031', 'whatever')$$),
          '23514:', 'A04-3 kind 亂值被拒');
delete from customer_line_outbox where dedupe_key = 'pgtap-dup';

-- A05:舊值仍可寫、新值可寫、亂值被拒
select is(pg_temp.err($$insert into line_notification_log (merchant_id, event_type, target_type, status, skip_reason) values ('c5a00000-0000-4000-8000-000000000031', 'booking_created', 'admin', 'skipped', 'target_not_bound')$$),
          'ok', 'A05-1 舊 event_type / skip_reason 仍可寫');
select is(pg_temp.err($$insert into line_notification_log (merchant_id, event_type, target_type, status, skip_reason, target_user_id, outbox_id) values ('c5a00000-0000-4000-8000-000000000031', 'customer_cancelled_by_customer', 'member', 'skipped', 'superseded', 'c5a00000-0000-4000-8000-000000000011', gen_random_uuid())$$),
          'ok', 'A05-2 新 event_type / skip_reason / target_user_id / outbox_id 可寫');
select is(pg_temp.err($$insert into line_notification_log (merchant_id, event_type, target_type, status) values ('c5a00000-0000-4000-8000-000000000031', 'customer_whatever', 'member', 'sent')$$),
          '23514:', 'A05-3 event_type 亂值被拒');
select is(pg_temp.err($$insert into line_notification_log (merchant_id, event_type, target_type, status, skip_reason) values ('c5a00000-0000-4000-8000-000000000031', 'customer_confirmed', 'member', 'skipped', 'whatever')$$),
          '23514:', 'A05-4 skip_reason 亂值被拒');
select is(
  (select array_agg(x order by x) from unnest(array['customer_submitted','customer_scheduled_by_store','customer_confirmed','customer_rescheduled',
     'customer_cancelled_by_store','customer_cancelled_by_customer','customer_reminder','customer_completed','customer_contact_request',
     'customer_contact_removed','customer_contact_request_resolved']) x
   where pg_temp.err(format($f$insert into line_notification_log (merchant_id, event_type, target_type, status) values ('c5a00000-0000-4000-8000-000000000031', %L, 'member', 'sent')$f$, x)) = 'ok'),
  array['customer_cancelled_by_customer','customer_cancelled_by_store','customer_completed','customer_confirmed','customer_contact_removed',
        'customer_contact_request','customer_contact_request_resolved','customer_reminder','customer_rescheduled','customer_scheduled_by_store','customer_submitted'],
  'A05-5 11 種客人事件都可寫');
select is(pg_temp.err($$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body) values ('c5a00000-0000-4000-8000-000000000001', 'c5a00000-0000-4000-8000-000000000031', 'admin', gen_random_uuid(), 'line_quota_exhausted', 't', 'b')$$),
          'ok', 'A05-6 鈴鐺 line_quota_exhausted 可寫');
select is(pg_temp.err($$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body) values ('c5a00000-0000-4000-8000-000000000001', 'c5a00000-0000-4000-8000-000000000031', 'admin', gen_random_uuid(), 'member_contact_request', 't', 'b')$$),
          'ok', 'A05-7 鈴鐺舊值 member_contact_request 仍可寫');
delete from line_notification_log where merchant_id = 'c5a00000-0000-4000-8000-000000000031';
delete from user_notifications where merchant_id = 'c5a00000-0000-4000-8000-000000000031';

-- =========================================================================
-- actor:booking_actor_kind
-- =========================================================================
select is(private.booking_actor_kind('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000011'), 'customer', 'actor-1 客戶帳號 ⇒ customer');
select is(private.booking_actor_kind('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000003'), 'staff', 'actor-2 服務人員本人 ⇒ staff');
select is(private.booking_actor_kind('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000005'), 'store', 'actor-3 管理員兼服務人員 ⇒ store');
select is(private.booking_actor_kind('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000001'), 'store', 'actor-4 管理員 ⇒ store');
select is(private.booking_actor_kind('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000002'), 'store', 'actor-5 客服 ⇒ store');
select is(private.booking_actor_kind('c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000004'), 'store', 'actor-6 集團管理員 ⇒ store');
select is(private.booking_actor_kind('c5a00000-0000-4000-8000-000000000031', null), 'store', 'actor-7 沒有人(null)⇒ store');

-- =========================================================================
-- S02 新增
-- =========================================================================
select pg_temp.mk('00101', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'customer', 'customer', 'c5a00000-0000-4000-8000-000000000011', 'pending_confirmation');
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000101'), array['customer_submitted', 'store_booking_created'],
          'N01/S06 客人線上送出 ⇒ 客人一筆 + 店家一筆');
select is((select payload ->> 'initial_status' from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000101' and kind = 'customer_submitted'),
          'pending_confirmation', 'N01 payload 記送出當下的狀態(選範本用)');
select is((select array[merchant_id::text, member_id::text, subject_user_id::text, status, dedupe_key] from customer_line_outbox
           where booking_id = 'c5a00000-0000-4000-8000-000000000101' and kind = 'customer_submitted'),
          array['c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000041', 'c5a00000-0000-4000-8000-000000000011',
                'pending', 'submitted:c5a00000-0000-4000-8000-000000000101'], 'N01 待發列欄位');

select pg_temp.mk('00102', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', null,
                  'customer', 'customer', null, 'pending_confirmation', true);
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000102'), array['store_booking_created'],
          'N 共同規則:訂單沒有會員 ⇒ 不通知客人,店家那筆照寫');

select pg_temp.mk('00103', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'accepted');
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000103'), array[]::text[], 'N02 店家建單:預設關 ⇒ 不寫;也沒有店家那筆(後台照舊由前端發)');

insert into merchant_customer_line_settings (merchant_id, on_scheduled_by_store) values ('c5a00000-0000-4000-8000-000000000031', true);
select pg_temp.mk('00104', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'staff', 'c5a00000-0000-4000-8000-000000000003', 'pending_confirmation');
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000104'), array['customer_scheduled_by_store'], 'N02 打開後:店家 / 服務人員建單(待確認)⇒ 寫');
select pg_temp.mk('00105', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'import', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'accepted');
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000105'), array[]::text[], 'N 共同規則:匯入的單不發 ⚠️');
update merchant_customer_line_settings set on_scheduled_by_store = false where merchant_id = 'c5a00000-0000-4000-8000-000000000031';
update customer_line_outbox set status = 'sent' where booking_id = 'c5a00000-0000-4000-8000-000000000105';
update bookings set status = 'cancelled', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000105';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000105'), array[]::text[], 'N 共同規則:匯入的單之後被取消也不發');

select pg_temp.mk('00106', 'c5a00000-0000-4000-8000-000000000032', 'c5a00000-0000-4000-8000-000000000053', 'c5a00000-0000-4000-8000-000000000042',
                  'customer', 'customer', 'c5a00000-0000-4000-8000-000000000012', 'pending_confirmation');
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000106'), array[]::text[], 'S01 沒接上官方帳號的店 ⇒ 0 列');
update bookings set status = 'accepted', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000106';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000106'), array[]::text[], 'S01 沒接上的店確認 ⇒ 0 列');

-- =========================================================================
-- S02 狀態變化 × 做的人
-- =========================================================================
update bookings set status = 'accepted', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000101';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000101'), array['customer_confirmed', 'customer_submitted', 'store_booking_created'],
          'N03 店家確認 ⇒ 多一筆 confirmed');
select is((select payload ->> 'actor_kind' from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000101' and kind = 'customer_confirmed'),
          'store', 'N03 做的人 = store');

update bookings set status = 'accepted', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000003' where id = 'c5a00000-0000-4000-8000-000000000104';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000104'), array['customer_confirmed', 'customer_scheduled_by_store'],
          'N03 服務人員確認接單也算確認');

-- 只換服務人員、不改時間
update customer_line_outbox set status = 'sent' where booking_id = 'c5a00000-0000-4000-8000-000000000104';
update bookings set staff_id = 'c5a00000-0000-4000-8000-000000000052', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000104';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and status = 'pending'),
          0, 'N04 只換服務人員、不改時間 ⇒ 不寫(第 3 批 Q5)');

-- 服務人員改時間(帳號判斷)
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000003'
where id = 'c5a00000-0000-4000-8000-000000000104';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and status = 'pending'),
          0, 'N04 服務人員改時間 ⇒ 不寫(#986)');
-- 服務人員端操作(交易內 GUC),即使帳號同時是管理員
select set_config('miaoyue.staff_order_actor', 'c5a00000-0000-4000-8000-000000000052', true);
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000005'
where id = 'c5a00000-0000-4000-8000-000000000104';
select set_config('miaoyue.staff_order_actor', '', true);
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and status = 'pending'),
          0, 'N04 從服務人員端改時間(GUC staff_order_actor)⇒ 不寫,即使帳號同時是管理員');

-- 店家改時間 + 合併
select start_at as orig from bookings where id = 'c5a00000-0000-4000-8000-000000000104' \gset
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000104';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled' and status = 'pending'),
          1, 'N04 店家改時間 ⇒ 一筆 rescheduled');
select ok((select send_after between now() + interval '2 minutes 59 seconds' and now() + interval '3 minutes 1 second'
           from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled'),
          'N04 send_after = 現在 + 3 分鐘');
select is((select (payload ->> 'old_start_at')::timestamptz from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled'),
          :'orig'::timestamptz, 'N04 payload.old_start_at = 改之前的時間');
update customer_line_outbox set send_after = now() - interval '1 minute'
where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled';
update bookings set start_at = start_at + interval '2 hours', end_at = end_at + interval '2 hours',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000002'
where id = 'c5a00000-0000-4000-8000-000000000104';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled'),
          1, 'N04 合併:再改一次仍只有一筆');
select is((select (payload ->> 'old_start_at')::timestamptz from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled'),
          :'orig'::timestamptz, 'N04 合併:old_start_at 保留第一次改之前的時間');
select ok((select send_after > now() + interval '2 minutes' from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled'),
          'N04 合併:send_after 往後延');
-- 領取中(processing)時再改(QA M1):另寫一則新的待發列,之後再改合併進新的這則
update customer_line_outbox set status = 'processing' where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled';
select id as proc_id, send_after as proc_send_after, payload as proc_payload from customer_line_outbox
where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled' \gset
select start_at as t_x from bookings where id = 'c5a00000-0000-4000-8000-000000000104' \gset
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000104';
select is((select array_agg(status order by status) from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled'),
          array['pending', 'processing'], 'N04 發送中又改(QA M1):另寫一則新的待發列');
select is((select (payload ->> 'old_start_at')::timestamptz from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled' and status = 'pending'),
          :'t_x'::timestamptz, 'N04 新的這則 old_start_at = 這次改之前的時間(發送中那則正要通知的時間)');
select ok((select dedupe_key = 'rescheduled:c5a00000-0000-4000-8000-000000000104:after:' || :'proc_id'
                  and send_after between now() + interval '2 minutes 59 seconds' and now() + interval '3 minutes 1 second'
           from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled' and status = 'pending'),
          'N04 新的這則:dedupe_key 帶發送中那則的 id、3 分鐘後發');
select is((select array[send_after::text, payload::text] from customer_line_outbox where id = :'proc_id'),
          array[:'proc_send_after'::timestamptz::text, :'proc_payload'::jsonb::text], 'N04 發送中那則完全沒被動到');
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000104';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled' and status = 'pending'),
          1, 'N04 之後再改:合併進新的待發列(仍只有一則 pending)');
select is((select (payload ->> 'old_start_at')::timestamptz from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled' and status = 'pending'),
          :'t_x'::timestamptz, 'N04 合併後 old_start_at 仍是發送中那則通知的時間');
-- 發送中那則結束後再改:合併進同一則 pending(不會因為 key 不同又多寫)
update customer_line_outbox set status = 'sent' where id = :'proc_id';
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000104';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000104' and kind = 'customer_rescheduled' and status = 'pending'),
          1, 'N04 發送中那則送完後再改:仍合併進同一則 pending');
update customer_line_outbox set status = 'sent' where booking_id = 'c5a00000-0000-4000-8000-000000000104';

-- 待確認 → 已確認 + 同時改時間 ⇒ 兩則都寫
select pg_temp.mk('00107', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'customer', 'customer', 'c5a00000-0000-4000-8000-000000000011', 'pending_confirmation');
update bookings set status = 'accepted', start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour',
                    last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000107';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000107'),
          array['customer_confirmed', 'customer_rescheduled', 'customer_submitted', 'store_booking_created'],
          'N03+N04 確認時順便改時間 ⇒ 兩則都寫 ⚠️');

-- 客人自己取消
update customer_line_outbox set status = 'sent' where booking_id = 'c5a00000-0000-4000-8000-000000000107';
insert into customer_line_outbox (merchant_id, kind, booking_id, member_id, dedupe_key)
values ('c5a00000-0000-4000-8000-000000000031', 'customer_reminder', 'c5a00000-0000-4000-8000-000000000107', 'c5a00000-0000-4000-8000-000000000041', 'pgtap-reminder');
update bookings set status = 'cancelled', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000011'
where id = 'c5a00000-0000-4000-8000-000000000107';
select is((select array_agg(kind order by kind) from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000107' and status = 'pending'),
          array['customer_cancelled_by_customer', 'store_booking_cancelled'], 'N06/S06 客人自己取消 ⇒ 通知其他聯絡人 + 店家那邊');
select is((select payload ->> 'actor_user_id' from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000107' and kind = 'customer_cancelled_by_customer'),
          'c5a00000-0000-4000-8000-000000000011', 'N06 payload 記取消的那位(收件人要扣掉)');
select is((select status || '/' || last_error from customer_line_outbox where dedupe_key = 'pgtap-reminder'),
          'skipped/stale', 'N 補充:狀態一變,還沒發的提醒列標 skipped / stale');

-- 店家取消
select pg_temp.mk('00108', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'accepted');
update bookings set status = 'cancelled', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000002'
where id = 'c5a00000-0000-4000-8000-000000000108';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000108'), array['customer_cancelled_by_store'],
          'N05 客服取消 ⇒ cancelled_by_store;沒有店家那筆(後台照舊由前端發)');
select pg_temp.mk('00109', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'accepted');
update bookings set status = 'cancelled', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000003'
where id = 'c5a00000-0000-4000-8000-000000000109';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000109'), array['customer_cancelled_by_store'],
          'N05 服務人員取消也通知客人(#986 只擋改時間)');

-- 完成、已完成被取消 / 還原
select pg_temp.mk('00110', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'accepted');
update bookings set status = 'completed', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000110';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000110'), array[]::text[], 'N08 完成:5-A 不寫(5-B)');
update bookings set status = 'accepted', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000110';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000110'), array[]::text[], 'N03 已完成「還原」回已確認不發');
update bookings set status = 'completed' where id = 'c5a00000-0000-4000-8000-000000000110';
update bookings set status = 'cancelled', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000110';
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000110'), array[]::text[], 'N05 補充:舊狀態 completed 被取消,trigger 一律不發');

-- cancel_completed_booking(真函式):勾通知才發
select pg_temp.mk('00111', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'completed');
select pg_temp.mk('00112', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'completed');
select pg_temp.as_user('c5a00000-0000-4000-8000-000000000001');
select lives_ok($$select public.cancel_completed_booking('c5a00000-0000-4000-8000-000000000111', '測試取消', false)$$, 'N05 補充:cancel_completed_booking(不通知)成功');
select lives_ok($$select public.cancel_completed_booking('c5a00000-0000-4000-8000-000000000112', '測試取消', true)$$, 'N05 補充:cancel_completed_booking(通知)成功');
select pg_temp.as_postgres();
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000111'), array[]::text[], 'N05 補充:管理員沒勾通知 ⇒ 不發(#844 Q2)');
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000112'), array['customer_cancelled_by_store'], 'N05 補充:管理員勾了通知 ⇒ cancelled_by_store');
select is((select payload ->> 'from_completed' from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000112'), 'true',
          'N05 補充:payload 標 from_completed');

-- 真函式 confirm_booking(管理員)
select pg_temp.mk('00113', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'customer', 'customer', 'c5a00000-0000-4000-8000-000000000011', 'pending_confirmation');
select pg_temp.as_user('c5a00000-0000-4000-8000-000000000001');
select lives_ok($$select public.confirm_booking('c5a00000-0000-4000-8000-000000000113')$$, 'N03 confirm_booking(真函式)成功');
select pg_temp.as_postgres();
select is((select payload ->> 'actor_kind' from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000113' and kind = 'customer_confirmed'),
          'store', 'N03 confirm_booking ⇒ confirmed,做的人 store');

-- =========================================================================
-- S01 開關 / 停發 / 失敗不影響訂單
-- =========================================================================
update merchant_customer_line_settings set on_confirmed = false where merchant_id = 'c5a00000-0000-4000-8000-000000000031';
select pg_temp.mk('00114', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'manual', 'admin', 'c5a00000-0000-4000-8000-000000000001', 'pending_confirmation');
update customer_line_outbox set status = 'sent' where booking_id = 'c5a00000-0000-4000-8000-000000000114';
update bookings set status = 'accepted', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000114';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000114' and kind = 'customer_confirmed'),
          0, 'S01 「店家確認」開關關掉 ⇒ 0 列');
update merchant_customer_line_settings set on_confirmed = true, quota_blocked_until = now() + interval '1 day' where merchant_id = 'c5a00000-0000-4000-8000-000000000031';
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000114';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000114' and status = 'pending'),
          0, 'S01 額度用完停發中 ⇒ 0 列 ⚠️');
update merchant_customer_line_settings set quota_blocked_until = now() - interval '1 second' where merchant_id = 'c5a00000-0000-4000-8000-000000000031';
update bookings set start_at = start_at + interval '1 hour', end_at = end_at + interval '1 hour', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001'
where id = 'c5a00000-0000-4000-8000-000000000114';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000114' and status = 'pending'),
          1, 'S01 停發期限過了 ⇒ 照常寫');

-- 店家這邊:模組 11 事件沒開 ⇒ 不寫店家那筆
update merchant_line_event_settings set enabled = false where merchant_id = 'c5a00000-0000-4000-8000-000000000031' and event_type = 'booking_created';
select pg_temp.mk('00115', 'c5a00000-0000-4000-8000-000000000031', 'c5a00000-0000-4000-8000-000000000051', 'c5a00000-0000-4000-8000-000000000041',
                  'customer', 'customer', 'c5a00000-0000-4000-8000-000000000011', 'pending_confirmation');
select is(pg_temp.kinds('c5a00000-0000-4000-8000-000000000115'), array['customer_submitted'], 'S06 模組 11「新預約」事件關掉 ⇒ 店家那筆不寫(客人那筆照寫)');

-- 故意讓寫入失敗(not valid 的 check 仍會擋新列)
alter table customer_line_outbox add constraint pgtap_c5_block check (false) not valid;
select lives_ok($$update public.bookings set status = 'cancelled', last_modified_by_user_id = 'c5a00000-0000-4000-8000-000000000001' where id = 'c5a00000-0000-4000-8000-000000000115'$$,
                'S01 待發列寫入失敗 ⇒ 訂單更新照樣成功');
select is((select status from bookings where id = 'c5a00000-0000-4000-8000-000000000115'), 'cancelled', 'S01 訂單狀態真的改了');
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5a00000-0000-4000-8000-000000000115' and kind = 'customer_cancelled_by_store'),
          0, 'S01 失敗時沒有半筆待發列');
alter table customer_line_outbox drop constraint pgtap_c5_block;

-- 直接呼叫 enqueue:沒接上的店 ⇒ 0 列;未知種類不丟例外
select lives_ok($$select private.enqueue_customer_line('customer_confirmed', 'c5a00000-0000-4000-8000-000000000032', null, null, null, '{}'::jsonb)$$,
                'S01 沒接上的店呼叫寫入口不丟例外');
select is((select count(*)::int from customer_line_outbox where merchant_id = 'c5a00000-0000-4000-8000-000000000032'), 0, 'S01 沒接上的店 0 列');

-- =========================================================================
-- trigger 本體
-- =========================================================================
select is((select array_agg(tgname::text order by tgname) from pg_trigger where tgrelid = 'public.bookings'::regclass and not tgisinternal),
          array['bookings_check_points_redeemed_requires_member', 'bookings_enqueue_customer_line', 'bookings_notify_merchant_calendar',
                -- #1035 B 批 PB-R03:多一個 bookings_refreeze_work_day(過去日子的訂單異動時重算日薪／時薪上工紀錄)。
                'bookings_notify_staff_schedule', 'bookings_refreeze_work_day', 'bookings_set_updated_at'],
          'S02 bookings trigger 清單(既有 4 個 + 新 1 個;#1035 B 批再 + 1 個)');
select ok((select pg_get_triggerdef(oid) like '%AFTER INSERT OR UPDATE OF status, start_at ON public.bookings FOR EACH ROW%'
           from pg_trigger where tgname = 'bookings_enqueue_customer_line'), 'S02 只在新增 / 改 status、start_at 時觸發');
select ok((select prosrc not ilike '%channel_access_token%' and prosrc not ilike '%net.http%'
           from pg_proc where oid = 'private.tg_bookings_enqueue_customer_line()'::regprocedure), 'S02 trigger 不讀 LINE 憑證、不連外');

select * from finish();
rollback;
