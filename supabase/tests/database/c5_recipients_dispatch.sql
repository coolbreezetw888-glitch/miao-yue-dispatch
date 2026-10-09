-- 客戶端第 5-A 批 — 收件人、領取 / 準備 / 結束、好友狀態(C5-R01、S04、S05、S06、F01/F02 資料庫端、X02、X04、X01 proacl)
-- 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md
begin;

select plan(67);

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

-- 收件人 / 略過 摘要:「user 尾碼:reason」
create function pg_temp.rcpt(p_outbox uuid)
returns text[] language sql as $$
  with r as (select private.resolve_customer_line_recipients(p_outbox) j)
  select coalesce(array_agg(x order by x), array[]::text[]) from (
    select 'to:' || coalesce(right(e ->> 'target_user_id', 2), 'legacy') x from r, jsonb_array_elements(j -> 'recipients') e
    union all
    select 'skip:' || coalesce(right(e ->> 'target_user_id', 2), '-') || ':' || (e ->> 'reason') from r, jsonb_array_elements(j -> 'skipped') e
  ) t
$$;

create function pg_temp.ob(p_id text, p_kind text, p_booking text, p_payload jsonb default '{}'::jsonb, p_status text default 'processing', p_merchant text default '31')
returns uuid language plpgsql as $$
declare v uuid := ('c5b00000-0000-4000-8000-0000000' || p_id)::uuid;
begin
  insert into public.customer_line_outbox (id, merchant_id, kind, booking_id, member_id, payload, status, claimed_at)
  values (v, ('c5b00000-0000-4000-8000-0000000000' || p_merchant)::uuid, p_kind,
          case when p_booking is null then null else ('c5b00000-0000-4000-8000-0000000' || p_booking)::uuid end,
          null, p_payload, p_status, case when p_status = 'processing' then now() end);
  return v;
end $$;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c5b00000-0000-4000-8000-000000000001', 'pgtap-c5b-admin@test.local', '{}'::jsonb);
insert into auth.users (id, email, raw_app_meta_data)
select ('c5b00000-0000-4000-8000-0000000000' || s)::uuid, 'line-pgtap-c5b-' || s || '@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb
from unnest(array['11','12','13','14']) s;

insert into groups (id) values ('c5b00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status, phone) values
  ('c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000091', '涼風C5B', 'on_site_dispatch', 'pgtap-c5b-a', 'active', '0223456789'),
  ('c5b00000-0000-4000-8000-000000000032', 'c5b00000-0000-4000-8000-000000000091', 'C5B別店', 'in_store_beauty', 'pgtap-c5b-b', 'active', null);
insert into merchant_admins (id, merchant_id, user_id) values
  ('c5b00000-0000-4000-8000-000000000081', 'c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000001');
update merchant_admins set line_bound = true, line_user_id = 'Uadmin00000000000000000000000c5b' where id = 'c5b00000-0000-4000-8000-000000000081';
insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected, line_bot_basic_id) values
  ('c5b00000-0000-4000-8000-000000000031', '1234567892', 'C5B-A-SECRET', 'C5B-A-TOKEN-SENTINEL', true, '@c5btest'),
  ('c5b00000-0000-4000-8000-000000000032', '1234567893', 'C5B-B-SECRET', 'C5B-B-TOKEN-SENTINEL', true, null);
insert into merchant_line_event_settings (merchant_id, event_type, enabled, notify_admin, notify_agent, notify_staff, notify_member, message_template) values
  ('c5b00000-0000-4000-8000-000000000031', 'booking_created', true, true, false, false, true, '{{customer_name}} 新預約');
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c5b00000-0000-4000-8000-000000000031', '5353535353', vault.create_secret('C5BFAKESECRET0000000000000000AA'), '00AA', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name) values
  ('c5b00000-0000-4000-8000-000000000011', '5353535353', 'U00000000000000000000000000c5b011', '小明'),
  ('c5b00000-0000-4000-8000-000000000012', '5353535353', 'U00000000000000000000000000c5b012', '王老闆'),
  ('c5b00000-0000-4000-8000-000000000013', '5353535353', 'U00000000000000000000000000c5b013', E'會計\n小姐'),
  ('c5b00000-0000-4000-8000-000000000014', '9999999999', 'U00000000000000000000000000c5b014', '別channel');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c5b00000-0000-4000-8000-000000000061', 'c5b00000-0000-4000-8000-000000000031', '室內機清洗', 1500, 'primary', 60),
  ('c5b00000-0000-4000-8000-000000000062', 'c5b00000-0000-4000-8000-000000000031', '加價項目', 300, 'addon', 10);
insert into merchant_staff (id, merchant_id, name, nickname, status, login_status, phone) values
  ('c5b00000-0000-4000-8000-000000000051', 'c5b00000-0000-4000-8000-000000000031', '本名不外流', '阿明', 'active', 'not_invited', '0900520051'),
  ('c5b00000-0000-4000-8000-000000000052', 'c5b00000-0000-4000-8000-000000000032', 'B店服務人員', null, 'active', 'not_invited', '0900520052');

insert into members (id, merchant_id, name, phone, referral_code) values
  ('c5b00000-0000-4000-8000-000000000041', 'c5b00000-0000-4000-8000-000000000031', '個人會員', '0912520001', 'C5BREF41'),
  ('c5b00000-0000-4000-8000-000000000042', 'c5b00000-0000-4000-8000-000000000031', '公司會員', '0912520002', 'C5BREF42'),
  ('c5b00000-0000-4000-8000-000000000043', 'c5b00000-0000-4000-8000-000000000031', '舊綁定會員', '0912520003', 'C5BREF43'),
  ('c5b00000-0000-4000-8000-000000000044', 'c5b00000-0000-4000-8000-000000000031', '沒LINE會員', '0912520004', 'C5BREF44'),
  ('c5b00000-0000-4000-8000-000000000045', 'c5b00000-0000-4000-8000-000000000031', '別channel會員', '0912520005', 'C5BREF45');
update members set line_bound = true, line_user_id = 'U00000000000000000000000000c5b043' where id = 'c5b00000-0000-4000-8000-000000000043';
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via) values
  ('c5b00000-0000-4000-8000-000000000071', 'c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000041', 'c5b00000-0000-4000-8000-000000000011', true, 'backfill'),
  ('c5b00000-0000-4000-8000-000000000072', 'c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000042', 'c5b00000-0000-4000-8000-000000000012', true, 'backfill'),
  ('c5b00000-0000-4000-8000-000000000073', 'c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000042', 'c5b00000-0000-4000-8000-000000000013', false, 'invite'),
  ('c5b00000-0000-4000-8000-000000000074', 'c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000045', 'c5b00000-0000-4000-8000-000000000014', true, 'backfill');

-- 訂單(2026-10-13 是星期二;台北 10:00 = UTC 02:00)
create function pg_temp.bk(p_id text, p_member text, p_by text, p_status text, p_guest boolean default false, p_merchant text default '31')
returns uuid language plpgsql as $$
declare v uuid := ('c5b00000-0000-4000-8000-0000000' || p_id)::uuid;
begin
  insert into public.bookings (id, merchant_id, staff_id, member_id, start_at, end_at, customer_name, customer_phone,
                               source, created_by_role, created_by_user_id, status, is_guest_booking)
  values (v, ('c5b00000-0000-4000-8000-0000000000' || p_merchant)::uuid,
          case when p_merchant = '31' then 'c5b00000-0000-4000-8000-000000000051'::uuid else 'c5b00000-0000-4000-8000-000000000052'::uuid end,
          case when p_member is null then null else ('c5b00000-0000-4000-8000-0000000000' || p_member)::uuid end,
          '2026-10-13 02:00:00+00', '2026-10-13 03:00:00+00', '客人', '0912520001',
          'customer', 'customer', case when p_by is null then null else ('c5b00000-0000-4000-8000-0000000000' || p_by)::uuid end,
          p_status, p_guest);
  return v;
end $$;
-- 店沒接上前建單(trigger 不寫列;待發列由測試自己放)
update merchant_line_configs set is_connected = false where merchant_id in ('c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000032');
select pg_temp.bk('00201', '41', '11', 'accepted');
select pg_temp.bk('00202', '42', '13', 'accepted');
select pg_temp.bk('00203', '42', '12', 'accepted');
select pg_temp.bk('00204', '42', null, 'accepted');
select pg_temp.bk('00205', '43', null, 'accepted');
select pg_temp.bk('00206', '44', null, 'accepted');
select pg_temp.bk('00207', '45', '14', 'accepted');
select pg_temp.bk('00208', '42', '13', 'pending_confirmation', true);
select pg_temp.bk('00209', null, null, 'accepted', true);
select pg_temp.bk('00210', '42', '13', 'cancelled');
select pg_temp.bk('00211', null, null, 'accepted', false, '32');
insert into booking_service_items (booking_id, service_item_id, quantity, unit_price_snapshot, duration_minutes_snapshot)
values ('c5b00000-0000-4000-8000-000000000201'::uuid, 'c5b00000-0000-4000-8000-000000000061'::uuid, 2, 1500, 60),
       ('c5b00000-0000-4000-8000-000000000201'::uuid, 'c5b00000-0000-4000-8000-000000000062'::uuid, 1, 300, 10);
update merchant_line_configs set is_connected = true where merchant_id in ('c5b00000-0000-4000-8000-000000000031', 'c5b00000-0000-4000-8000-000000000032');

-- =========================================================================
-- R01 收件人
-- =========================================================================
select is(pg_temp.rcpt(pg_temp.ob('00301', 'customer_confirmed', '00201')), array['to:11'], 'R01-1 個人會員 ⇒ 一人');
select is(pg_temp.rcpt(pg_temp.ob('00302', 'customer_confirmed', '00202')), array['to:12', 'to:13'], 'R01-2 公司會員第二聯絡人下單 ⇒ 主要 + 下單那位 2 人');
select is(pg_temp.rcpt(pg_temp.ob('00303', 'customer_confirmed', '00203')), array['to:12'], 'R01-3 主要聯絡人下單 ⇒ 1 人(重複只算一次)');
select is(pg_temp.rcpt(pg_temp.ob('00304', 'customer_confirmed', '00204')), array['to:12'], 'R01-4 店家建的單 ⇒ 只有主要(第二聯絡人沒下單不收 ⚠️)');
select is(pg_temp.rcpt(pg_temp.ob('00305', 'customer_confirmed', '00205')), array['to:legacy'], 'R01-5 舊綁定碼會員 ⇒ members.line_user_id');
select is(pg_temp.rcpt(pg_temp.ob('00306', 'customer_confirmed', '00206')), array['skip:-:target_not_bound'], 'R01-6 沒綁 LINE 的會員 ⇒ target_not_bound');
select is(pg_temp.rcpt(pg_temp.ob('00307', 'customer_confirmed', '00207')), array['skip:14:target_not_bound'], 'R01-7 身分是別的 LINE channel ⇒ target_not_bound ⚠️');
select is(pg_temp.rcpt(pg_temp.ob('00308', 'customer_confirmed', '00208')), array['to:12'], 'R01-8 訪客單掛到公司會員 ⇒ 只通知主要聯絡人(Q4=A)');
select is(pg_temp.rcpt(pg_temp.ob('00309', 'customer_confirmed', '00209')), array['skip:-:no_target'], 'R01-9 沒有會員 ⇒ no_target');
select is(pg_temp.rcpt(pg_temp.ob('00310', 'customer_cancelled_by_customer', '00210', '{"actor_user_id":"c5b00000-0000-4000-8000-000000000013"}')),
          array['to:12'], 'R01-10 客人取消 ⇒ 扣掉取消的那位');
select is(pg_temp.rcpt(pg_temp.ob('00311', 'customer_cancelled_by_customer', '00201', '{"actor_user_id":"c5b00000-0000-4000-8000-000000000011"}')),
          array[]::text[], 'R01-11 個人會員自己取消 ⇒ 剩 0 人(不發)');
update member_customer_contacts set notify_booking = false where id = 'c5b00000-0000-4000-8000-000000000073';
select is(pg_temp.rcpt('c5b00000-0000-4000-8000-000000000302'), array['skip:13:customer_opted_out', 'to:12'], 'R01-12 第二聯絡人關掉預約通知 ⇒ customer_opted_out');
update member_customer_contacts set notify_booking = true where id = 'c5b00000-0000-4000-8000-000000000073';
insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at) values
  ('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b012', false, 'webhook', now()),
  ('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b013', true, 'webhook', now());
select is(pg_temp.rcpt('c5b00000-0000-4000-8000-000000000302'), array['skip:12:not_friend', 'to:13'], 'R01-13 已知封鎖 / 沒加好友 ⇒ not_friend;已加好友照發');
insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at) values
  ('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b043', false, 'webhook', now());
select is(pg_temp.rcpt('c5b00000-0000-4000-8000-000000000305'), array['skip:-:not_friend'], 'R01-14 舊綁定碼會員封鎖 ⇒ not_friend');
delete from customer_line_friendships where merchant_id = 'c5b00000-0000-4000-8000-000000000031';

-- =========================================================================
-- S05 prepare
-- =========================================================================
select public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000301') as j \gset p1_
select is(:'p1_j'::jsonb ->> 'state', 'send', 'S05-1 正常 ⇒ send');
select is(:'p1_j'::jsonb ->> 'channel_access_token', 'C5B-A-TOKEN-SENTINEL', 'S05-2 用這張單那間店的 token(X04)');
select is(:'p1_j'::jsonb ->> 'template', E'「{{merchant_name}}」已確認你的預約：\n{{booking_date}} {{booking_time}}（預計抵達時間）\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}',
          'S05-3 沒改過 ⇒ 預設範本(到府產業加「（預計抵達時間）」)');
select is(:'p1_j'::jsonb -> 'variables',
          '{"member_name":"個人會員","merchant_name":"涼風C5B","booking_date":"10月13日（二）","booking_time":"10:00","old_booking_date":"","old_booking_time":"","service_items":"室內機清洗 ×2、加價項目 ×1","staff_name":"阿明","merchant_phone":"0223456789","contact_name":""}'::jsonb,
          'N13 變數:日期格式、項目 ×數量(主要在前)、暱稱優先、不含金額 / 地址 / 本名');
select is(array[:'p1_j'::jsonb ->> 'slug', :'p1_j'::jsonb ->> 'log_event_type', :'p1_j'::jsonb ->> 'template_code'],
          array['pgtap-c5b-a', 'customer_confirmed', 'confirmed'], 'S05-4 slug / 記錄事件 / 範本代碼');
select is((select array_agg(e ->> 'to') from jsonb_array_elements(:'p1_j'::jsonb -> 'recipients') e),
          array['U00000000000000000000000000c5b011'], 'S05-5 收件人帶 LINE userId(只在 service role 這一層)');

insert into merchant_customer_line_settings (merchant_id, templates) values ('c5b00000-0000-4000-8000-000000000031', '{"confirmed":"自訂確認 {{booking_time}}"}');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000301') ->> 'template', '自訂確認 {{booking_time}}', 'S05-6 店家改過 ⇒ 用店家的');

select pg_temp.ob('00320', 'customer_submitted', '00208', '{"initial_status":"pending_confirmation"}');
select pg_temp.ob('00321', 'customer_submitted', '00201', '{"initial_status":"accepted"}');
select is(array[public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000320') ->> 'template_code',
                public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000321') ->> 'template_code'],
          array['submitted_pending', 'submitted_accepted'], 'S05-7 收到預約:依送出當下的狀態選範本');

-- 過時
select pg_temp.ob('00322', 'customer_confirmed', '00210');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000322') ->> 'state', 'stale', 'S05-8 確認但現在已取消 ⇒ stale');
select pg_temp.ob('00323', 'customer_cancelled_by_store', '00201');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000323') ->> 'state', 'stale', 'S05-9 取消但現在不是已取消 ⇒ stale');
select pg_temp.ob('00324', 'customer_rescheduled', '00201', '{"old_start_at":"2026-10-13T02:00:00+00:00"}');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000324') ->> 'state', 'superseded', 'S05-10 改時間又改回原時間 ⇒ superseded');
select pg_temp.ob('00325', 'customer_rescheduled', '00201', '{"old_start_at":"2026-10-12T02:00:00+00:00"}');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000325') -> 'variables' ->> 'old_booking_date', '10月12日（一）', 'S05-11 改時間:old 變數');
update customer_line_outbox set created_at = now() - interval '6 hours 1 minute' where id = 'c5b00000-0000-4000-8000-000000000325';
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000325') ->> 'state', 'stale', 'S05-12 超過 6 小時還沒發 ⇒ stale ⚠️');
update merchant_customer_line_settings set on_confirmed = false where merchant_id = 'c5b00000-0000-4000-8000-000000000031';
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000301') ->> 'state', 'skip', 'S05-13 等待中店家關掉那種通知 ⇒ 安靜結束');
update merchant_customer_line_settings set on_confirmed = true where merchant_id = 'c5b00000-0000-4000-8000-000000000031';
select pg_temp.ob('00326', 'customer_confirmed', '00201', '{}', 'pending');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000326') ->> 'state', 'not_claimed', 'S05-14 沒領取的列不能準備');
select pg_temp.ob('00327', 'customer_reminder', '00201');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000327') ->> 'reason', 'event_disabled',
          'S05-15 (5-B 起)提醒不再標 unsupported;店家沒開「服務前提醒」(Q1=A 預設關)⇒ 安靜結束');
select pg_temp.ob('00328', 'customer_cancelled_by_customer', '00210', '{"actor_user_id":"c5b00000-0000-4000-8000-000000000013"}');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000328') -> 'variables' ->> 'contact_name', E'會計\n小姐',
          'S05-16 客人取消:contact_name = 取消那位的 LINE 顯示名(換行由 Edge 代入時處理)');

-- 停發中:收件人全部轉略過 quota_exhausted
update merchant_customer_line_settings set quota_blocked_until = now() + interval '1 day' where merchant_id = 'c5b00000-0000-4000-8000-000000000031';
select public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000302') as j \gset pq_
select is(array[jsonb_array_length(:'pq_j'::jsonb -> 'recipients')::text,
                (select string_agg(e ->> 'reason', ',' order by e ->> 'reason') from jsonb_array_elements(:'pq_j'::jsonb -> 'skipped') e)],
          array['0', 'quota_exhausted,quota_exhausted'], 'S05-17 額度停發中 ⇒ 收件人全部 quota_exhausted');
update merchant_customer_line_settings set quota_blocked_until = null where merchant_id = 'c5b00000-0000-4000-8000-000000000031';

-- 重試冪等:已寫過記錄的對象不再處理
insert into line_notification_log (merchant_id, event_type, booking_id, target_type, target_id, target_user_id, status, outbox_id)
values ('c5b00000-0000-4000-8000-000000000031', 'customer_confirmed', 'c5b00000-0000-4000-8000-000000000202', 'member',
        'c5b00000-0000-4000-8000-000000000042', 'c5b00000-0000-4000-8000-000000000012', 'sent', 'c5b00000-0000-4000-8000-000000000302');
select is((select array_agg(right(e ->> 'target_user_id', 2)) from jsonb_array_elements(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000302') -> 'recipients') e),
          array['13'], 'S05-18 重試時已送出的那位不再送(冪等)');

-- S06 店家那邊
select pg_temp.ob('00330', 'store_booking_created', '00208');
select public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000330') as j \gset ps_
select is(array[:'ps_j'::jsonb ->> 'state', :'ps_j'::jsonb ->> 'log_event_type', :'ps_j'::jsonb ->> 'template',
                (select string_agg(e ->> 'target_type' || ':' || (e ->> 'to'), ',') from jsonb_array_elements(:'ps_j'::jsonb -> 'recipients') e)],
          array['send', 'booking_created', '{{customer_name}} 新預約', 'admin:Uadmin00000000000000000000000c5b'],
          'S06-1 客人送出 ⇒ 店家這邊照模組 11 設定(範本、管理員);沒有會員對象');
select ok(:'ps_j'::jsonb -> 'variables' ? 'customer_name', 'S06-2 變數用 render_booking_notification_variables');

-- X04:B 店的待發列用 B 店 token
select pg_temp.ob('00331', 'customer_confirmed', '00211', '{}', 'processing', '32');
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000331') ->> 'channel_access_token', 'C5B-B-TOKEN-SENTINEL', 'X04-1 B 店的列用 B 店自己的 token');
update customer_line_outbox set booking_id = 'c5b00000-0000-4000-8000-000000000201' where id = 'c5b00000-0000-4000-8000-000000000331';
select is(public.internal_prepare_customer_line_job('c5b00000-0000-4000-8000-000000000331') ->> 'reason', 'no_booking', 'X04-2 B 店的列指到 A 店的單 ⇒ no_booking(不會用 A 店資料)');

-- =========================================================================
-- S04 / S05 claim、finish
-- =========================================================================
delete from customer_line_outbox;
select pg_temp.ob('00401', 'customer_confirmed', '00201', '{}', 'pending');
select pg_temp.ob('00402', 'customer_confirmed', '00203', '{}', 'pending');
update customer_line_outbox set send_after = now() + interval '3 minutes' where id = 'c5b00000-0000-4000-8000-000000000402';
select pg_temp.ob('00403', 'customer_confirmed', '00204', '{}', 'processing');
update customer_line_outbox set claimed_at = now() - interval '11 minutes' where id = 'c5b00000-0000-4000-8000-000000000403';
select is((select array_agg(right(id::text, 3) order by id) from public.internal_claim_customer_line_outbox(50)),
          array['401', '403'], 'S04-1 領到到期的列 + 卡住超過 10 分鐘放回的列;還沒到期的不領');
select is((select array_agg(status || ':' || attempts order by id) from customer_line_outbox),
          array['processing:0', 'pending:0', 'processing:1'], 'S04-2 領到的標 processing;卡住的 attempts + 1');
select is(public.internal_claim_customer_line_outbox(50)::text, null, 'S04-3 已領的不會被重領');

select is(public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000401', 'retry', 'HTTP 500') ->> 'state', 'retry', 'S05-r1 5xx ⇒ 重試');
select ok((select status = 'pending' and attempts = 1 and send_after between now() + interval '59 seconds' and now() + interval '61 seconds'
           from customer_line_outbox where id = 'c5b00000-0000-4000-8000-000000000401'), 'S05-r2 第 1 次重試在 1 分鐘後');
update customer_line_outbox set status = 'processing', attempts = 2 where id = 'c5b00000-0000-4000-8000-000000000401';
select public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000401', 'retry', null);
select ok((select send_after between now() + interval '14 minutes 59 seconds' and now() + interval '15 minutes 1 second'
           from customer_line_outbox where id = 'c5b00000-0000-4000-8000-000000000401'), 'S05-r3 第 3 次重試在 15 分鐘後');
update customer_line_outbox set status = 'processing' where id = 'c5b00000-0000-4000-8000-000000000401';
select is(public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000401', 'retry', repeat('長', 900)) ->> 'state', 'failed', 'S05-r4 重試 3 次後 ⇒ failed');
select is((select char_length(last_error) from customer_line_outbox where id = 'c5b00000-0000-4000-8000-000000000401'), 500, 'S05-r5 last_error 截 500 字');
select is(public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000401', 'sent', null) ->> 'state', 'not_claimed', 'S05-r6 不是 processing 的列不能回寫');
select is(pg_temp.err($$select public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000403', 'whatever', null)$$), '22023:invalid_outcome', 'S05-r7 結果代碼亂值被拒');
select is(public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000403', 'sent', null) ->> 'state', 'sent', 'S05-r8 送出 ⇒ sent');

-- 額度用完
select pg_temp.ob('00404', 'customer_confirmed', '00205', '{}', 'processing');
select pg_temp.ob('00405', 'customer_confirmed', '00211', '{}', 'pending', '32');
select is(public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000404', 'quota_exhausted', null) ->> 'state', 'quota_exhausted', 'S05-q1 LINE 額度用完');
select is((select quota_blocked_until from merchant_customer_line_settings where merchant_id = 'c5b00000-0000-4000-8000-000000000031'),
          (date_trunc('month', now() at time zone 'Asia/Taipei') + interval '1 month') at time zone 'Asia/Taipei', 'S05-q2 停發到下個月 1 日台北 00:00');
select is((select array_agg(right(id::text, 3) || ':' || status || ':' || coalesce(last_error, '') order by id) from customer_line_outbox where id in (
             'c5b00000-0000-4000-8000-000000000402', 'c5b00000-0000-4000-8000-000000000404', 'c5b00000-0000-4000-8000-000000000405')),
          array['402:skipped:quota_exhausted', '404:skipped:quota_exhausted', '405:pending:'], 'S05-q3 這間店其他待發列全部略過;別間店不受影響');
select is((select array_agg(event_type || ':' || target_type || ':' || title) from user_notifications where merchant_id = 'c5b00000-0000-4000-8000-000000000031'),
          array['line_quota_exhausted:admin:LINE 訊息額度已用完'], 'S05-q4 管理員鈴鐺一則');
select pg_temp.ob('00406', 'customer_confirmed', '00201', '{}', 'processing');
select public.internal_finish_customer_line_job('c5b00000-0000-4000-8000-000000000406', 'quota_exhausted', null);
select is((select count(*)::int from user_notifications where merchant_id = 'c5b00000-0000-4000-8000-000000000031'), 1, 'S05-q5 同月只發一次');

-- =========================================================================
-- F01 / F02 好友狀態
-- =========================================================================
select is(public.internal_set_line_friendship('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b011', true, '2026-10-09 10:00+08', 'webhook'), true, 'F01-1 follow 寫入');
select is(public.internal_set_line_friendship('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b011', false, '2026-10-09 09:00+08', 'webhook'), false, 'F01-2 比較舊的事件(亂序 / 重送)不覆蓋');
select is((select is_friend from customer_line_friendships where line_user_id = 'U00000000000000000000000000c5b011'), true, 'F01-3 仍是好友');
select is(public.internal_set_line_friendship('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b011', false, '2026-10-09 11:00+08', 'webhook'), true, 'F01-4 unfollow(較新)⇒ 覆蓋');
select is(public.internal_set_line_friendship('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b011', true, '2026-10-09 11:30+08', 'login'), true, 'F02-1 登入時 friendFlag 也能寫');
select is((select is_friend::text || ':' || source from customer_line_friendships where line_user_id = 'U00000000000000000000000000c5b011'), 'true:login', 'F02-2 來源記 login');
select is(array[
  public.internal_set_line_friendship('c5b00000-0000-4000-8000-000000000031', 'not-a-line-id', true, now(), 'webhook'),
  public.internal_set_line_friendship('c5b00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5b099', true, now(), 'other'),
  public.internal_set_line_friendship('00000000-0000-4000-8000-000000000000', 'U00000000000000000000000000c5b099', true, now(), 'webhook')],
  array[false, false, false], 'F01-5 格式錯的 userId / 來源 / 不存在的店 ⇒ 不寫');

-- =========================================================================
-- X01 proacl / X02 機密
-- =========================================================================
select is((select array_agg(p.proname || '=' || array_to_string(p.proacl, ',') order by p.proname) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname in ('internal_claim_customer_line_outbox', 'internal_prepare_customer_line_job',
             'internal_finish_customer_line_job', 'internal_set_line_friendship')),
          array['internal_claim_customer_line_outbox=postgres=X/postgres,service_role=X/postgres',
                'internal_finish_customer_line_job=postgres=X/postgres,service_role=X/postgres',
                'internal_prepare_customer_line_job=postgres=X/postgres,service_role=X/postgres',
                'internal_set_line_friendship=postgres=X/postgres,service_role=X/postgres'],
          'X01-1 internal_* 只給 service_role');
select is((select array_agg(p.proname order by p.proname) from pg_proc p
           where p.pronamespace = 'private'::regnamespace
             and p.proname in ('customer_line_settings', 'customer_line_kind_enabled', 'customer_line_template_codes', 'customer_line_default_templates',
               'customer_line_notify_available', 'customer_line_add_friend_url', 'customer_line_friend_status', 'customer_line_user_id_for',
               'booking_actor_kind', 'enqueue_customer_line', 'tg_bookings_enqueue_customer_line', 'resolve_customer_line_recipients',
               'customer_line_format_date', 'customer_line_format_time', 'customer_line_booking_variables', 'customer_notify_prefs_view',
               'default_member_completion_message', 'customer_line_settings_view')
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))),
          null, 'X01-2 新 private 函式 anon / authenticated / service_role 都不能執行');
select is((select count(*)::int from pg_proc where pronamespace = 'private'::regnamespace
           and proname in ('customer_line_settings', 'customer_line_kind_enabled', 'customer_line_template_codes', 'customer_line_default_templates',
               'customer_line_notify_available', 'customer_line_add_friend_url', 'customer_line_friend_status', 'customer_line_user_id_for',
               'booking_actor_kind', 'enqueue_customer_line', 'tg_bookings_enqueue_customer_line', 'resolve_customer_line_recipients',
               'customer_line_format_date', 'customer_line_format_time', 'customer_line_booking_variables', 'customer_notify_prefs_view',
               'default_member_completion_message', 'customer_line_settings_view')),
          18, 'X01-3 上面檢查的 18 支都存在(防打錯名字)');
select is((select count(*)::int from customer_line_outbox o where o.payload::text ilike '%TOKEN%' or o.payload::text ilike '%SECRET%' or o.payload::text ~ 'U[0-9a-f]{32}'),
          0, 'X02-1 待發清單不存 token / secret / LINE userId');
select ok((select prosrc not ilike '%channel_access_token%' from pg_proc where oid = 'private.enqueue_customer_line(text,uuid,uuid,uuid,uuid,jsonb,timestamptz,text)'::regprocedure),
          'X02-2 寫入口不讀 token');
select ok((select command not ilike '%customer_line_cron_secret'' %' and command ilike '%vault.decrypted_secrets%'
                  and command ilike '%customer-line-notify-dispatch%' and command ilike '%status = ''pending'' and send_after <= now()%'
           from cron.job where jobname = 'customer-line-dispatch-every-minute'),
          'S04-4 每分鐘排程存在、密鑰只從 Vault 讀、沒有到期列不呼叫');
select is((select schedule from cron.job where jobname = 'customer-line-dispatch-every-minute'), '* * * * *', 'S04-5 每分鐘');
select ok(exists (select 1 from cron.job where jobname = 'customer-line-outbox-prune-daily' and command ilike '%30 days%'), 'A04 清理排程(30 天)');

select * from finish();
rollback;
