-- 客戶端第 5-B 批 — 每月上限、本月用量、80% 鈴鐺、行銷 / 生日照「優惠通知」、訪客單通知主要聯絡人
-- 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md(零之零:Q3=A 預設不設上限、80% 與用完鈴鐺;Q4=A;Q7 主腦)
--
--   Q01  prepare:上限截斷(先排除已寫過記錄的人)、只算本月 / 只算 customer_* / 只算 sent;店家那邊不受限;沒設 ⇒ null
--   K02  set_customer_line_monthly_cap:只有管理員;範圍;null 清除;update_customer_line_settings 仍不收 monthly_cap
--   Q02  get_customer_line_usage:權限、分類統計、不含 token
--   Q04  internal_line_quota_check_due(每小時一次)、internal_line_quota_warning(80%、同月一則、只給管理員)
--   P01  preview_line_marketing_recipients(則數規則、黑名單、權限、不含 LINE userId)、internal_line_marketing_candidates
--   P02  claim_birthday_line_pending:主要聯絡人關掉優惠通知 ⇒ skipped_opted_out;開著 / 舊綁定碼照舊
--   Q4   訪客單掛到有聯絡人的會員 ⇒ 寫待發列、只通知主要聯絡人
--   X01  新函式 proacl
begin;

select plan(52);

create function pg_temp.as_user(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;
create function pg_temp.as_anon()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
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
grant execute on function pg_temp.as_anon() to anon, authenticated, service_role;
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

create function pg_temp.u(p text) returns uuid language plpgsql as $$ begin return ('c5e00000-0000-4000-8000-0000000000' || p)::uuid; end $$;
grant execute on function pg_temp.u(text) to anon, authenticated, service_role;

create function pg_temp.rc(j jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(x order by x), array[]::text[]) from (
    select 'to:' || coalesce(right(e ->> 'target_user_id', 2), e ->> 'target_type') x from jsonb_array_elements(j -> 'recipients') e
    union all
    select 'skip:' || coalesce(right(e ->> 'target_user_id', 2), e ->> 'target_type') || ':' || (e ->> 'reason') from jsonb_array_elements(j -> 'skipped') e
  ) t
$$;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c5e00000-0000-4000-8000-000000000001', 'pgtap-c5e-admin@test.local', '{}'::jsonb),
  ('c5e00000-0000-4000-8000-000000000002', 'pgtap-c5e-agent-line@test.local', '{}'::jsonb),
  ('c5e00000-0000-4000-8000-000000000003', 'pgtap-c5e-agent-none@test.local', '{}'::jsonb),
  ('c5e00000-0000-4000-8000-000000000004', 'pgtap-c5e-agent-mkt@test.local', '{}'::jsonb);
insert into auth.users (id, email, raw_app_meta_data)
select pg_temp.u(s), 'line-pgtap-c5e-' || s || '@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb
from unnest(array['11','12','13','14','15']) s;

insert into groups (id) values ('c5e00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status, phone) values
  ('c5e00000-0000-4000-8000-000000000031', 'c5e00000-0000-4000-8000-000000000091', 'C5E額度店', 'in_store_beauty', 'pgtap-c5e-a', 'active', '0223456789'),
  ('c5e00000-0000-4000-8000-000000000032', 'c5e00000-0000-4000-8000-000000000091', 'C5E別店', 'in_store_beauty', 'pgtap-c5e-b', 'active', null);
insert into merchant_admins (id, merchant_id, user_id) values
  ('c5e00000-0000-4000-8000-000000000081', 'c5e00000-0000-4000-8000-000000000031', 'c5e00000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c5e00000-0000-4000-8000-000000000082', 'c5e00000-0000-4000-8000-000000000031', 'c5e00000-0000-4000-8000-000000000002', 'LINE客服', '0900550082', 'pgtap-c5e-agent-line@test.local', 'active'),
  ('c5e00000-0000-4000-8000-000000000083', 'c5e00000-0000-4000-8000-000000000031', 'c5e00000-0000-4000-8000-000000000003', '沒權限客服', '0900550083', 'pgtap-c5e-agent-none@test.local', 'active'),
  ('c5e00000-0000-4000-8000-000000000084', 'c5e00000-0000-4000-8000-000000000031', 'c5e00000-0000-4000-8000-000000000004', '行銷客服', '0900550084', 'pgtap-c5e-agent-mkt@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c5e00000-0000-4000-8000-000000000082', 'line_notification', true),
  ('c5e00000-0000-4000-8000-000000000084', 'line_marketing', true);
insert into merchant_staff (id, merchant_id, name, status, login_status, phone) values
  ('c5e00000-0000-4000-8000-000000000051', 'c5e00000-0000-4000-8000-000000000031', 'C5E服務人員', 'active', 'not_invited', '0900550051');
insert into merchant_line_configs (merchant_id, channel_id, channel_secret_vault_id, channel_access_token_vault_id, channel_secret_last4, channel_access_token_last4, is_connected) values
  ('c5e00000-0000-4000-8000-000000000031', '1234567821', vault.create_secret('C5E-A-SECRET'), vault.create_secret('C5E-A-TOKEN-SENTINEL'), right('C5E-A-SECRET', 4), right('C5E-A-TOKEN-SENTINEL', 4), true),
  ('c5e00000-0000-4000-8000-000000000032', '1234567822', vault.create_secret('C5E-B-SECRET'), vault.create_secret('C5E-B-TOKEN-SENTINEL'), right('C5E-B-SECRET', 4), right('C5E-B-TOKEN-SENTINEL', 4), true);
insert into merchant_line_event_settings (merchant_id, event_type, enabled, notify_admin, notify_agent, notify_staff, notify_member, message_template) values
  ('c5e00000-0000-4000-8000-000000000031', 'booking_created', true, true, false, false, false, '新預約');
update merchant_admins set line_bound = true, line_user_id = 'Uadmin000000000000000000000000c5e' where id = 'c5e00000-0000-4000-8000-000000000081';
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c5e00000-0000-4000-8000-000000000031', '5858585858', vault.create_secret('C5EFAKESECRET00000000000000000AA'), '00AA', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name)
select pg_temp.u(s), case when s = '15' then '9999999999' else '5858585858' end, 'U00000000000000000000000000c5e0' || s, 'LINE' || s
from unnest(array['11','12','13','14','15']) s;

-- 41 公司會員:主要 11、第二聯絡人 12(優惠關)、13(已知非好友);42 個人會員:主要 14(優惠關);
-- 43 舊綁定碼(沒聯絡人);44 黑名單公司(主要 15 是別 channel);45 別店會員
insert into members (id, merchant_id, name, phone, referral_code) values
  (pg_temp.u('41'), 'c5e00000-0000-4000-8000-000000000031', '公司會員', '0912550001', 'C5EREF41'),
  (pg_temp.u('42'), 'c5e00000-0000-4000-8000-000000000031', '個人會員', '0912550002', 'C5EREF42'),
  (pg_temp.u('43'), 'c5e00000-0000-4000-8000-000000000031', '舊綁定會員', '0912550003', 'C5EREF43'),
  (pg_temp.u('44'), 'c5e00000-0000-4000-8000-000000000031', '黑名單會員', '0912550004', 'C5EREF44'),
  (pg_temp.u('45'), 'c5e00000-0000-4000-8000-000000000032', '別店會員', '0912550005', 'C5EREF45');
update members set line_bound = true, line_user_id = 'U00000000000000000000000000c5e043' where id = pg_temp.u('43');
update members set is_blacklisted = true where id = pg_temp.u('44');
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via, notify_promo) values
  (pg_temp.u('71'), 'c5e00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('11'), true, 'backfill', true),
  (pg_temp.u('72'), 'c5e00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('12'), false, 'invite', false),
  (pg_temp.u('73'), 'c5e00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('13'), false, 'invite', true),
  (pg_temp.u('74'), 'c5e00000-0000-4000-8000-000000000031', pg_temp.u('42'), pg_temp.u('14'), true, 'backfill', false),
  (pg_temp.u('75'), 'c5e00000-0000-4000-8000-000000000031', pg_temp.u('44'), pg_temp.u('15'), true, 'backfill', true);
select private.member_sync_primary(pg_temp.u('41'));
select private.member_sync_primary(pg_temp.u('42'));
select private.member_sync_primary(pg_temp.u('44'));
insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at) values
  ('c5e00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5e013', false, 'webhook', now());

-- 訂單(店沒接上時建,trigger 不寫;待發列測試自己放)
update merchant_line_configs set is_connected = false where merchant_id = 'c5e00000-0000-4000-8000-000000000031';
insert into bookings (id, merchant_id, staff_id, member_id, start_at, end_at, customer_name, customer_phone, source, created_by_role, created_by_user_id, status)
values (pg_temp.u('91'), 'c5e00000-0000-4000-8000-000000000031', 'c5e00000-0000-4000-8000-000000000051', pg_temp.u('41'),
        now() + interval '2 days', now() + interval '2 days 1 hour', '客人', '0912550001', 'customer', 'customer', pg_temp.u('13'), 'accepted');
update merchant_line_configs set is_connected = true where merchant_id = 'c5e00000-0000-4000-8000-000000000031';

create function pg_temp.ob(p_id text, p_kind text)
returns uuid language plpgsql as $$
declare v uuid := ('c5e00000-0000-4000-8000-0000000' || p_id)::uuid;
begin
  insert into public.customer_line_outbox (id, merchant_id, kind, booking_id, member_id, status, claimed_at)
  values (v, 'c5e00000-0000-4000-8000-000000000031', p_kind, pg_temp.u('91'), pg_temp.u('41'), 'processing', now());
  return v;
end $$;

create function pg_temp.log(p_event text, p_status text, p_at timestamptz, p_merchant text default '31')
returns void language plpgsql as $$
begin
  insert into public.line_notification_log (merchant_id, event_type, target_type, target_id, status, attempted_at)
  values (('c5e00000-0000-4000-8000-0000000000' || p_merchant)::uuid, p_event, 'member', pg_temp.u('42'), p_status, p_at);
end $$;

-- 收件人:主要 11 + 下單的 13;13 已知非好友 ⇒ 實際只有 11。改成 13 也是好友,方便測上限
delete from customer_line_friendships where merchant_id = 'c5e00000-0000-4000-8000-000000000031';

-- =========================================================================
-- Q01 每月上限
-- =========================================================================
select is(public.internal_prepare_customer_line_job(pg_temp.ob('00301', 'customer_confirmed')) -> 'cap_remaining', 'null'::jsonb, 'Q01-1 沒設上限(Q3=A 預設)⇒ cap_remaining null');
select is(pg_temp.rc(public.internal_prepare_customer_line_job('c5e00000-0000-4000-8000-000000000301')), array['to:11', 'to:13'], 'Q01-2 沒設上限 ⇒ 兩位都發');

insert into merchant_customer_line_settings (merchant_id, monthly_cap) values ('c5e00000-0000-4000-8000-000000000031', 3);
select pg_temp.log('customer_confirmed', 'sent', now());
select pg_temp.log('customer_submitted', 'sent', now());
select pg_temp.log('customer_submitted', 'sent', date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei' - interval '1 minute');  -- 上個月(台北)
select pg_temp.log('customer_submitted', 'failed', now());     -- 失敗不算
select pg_temp.log('customer_submitted', 'skipped', now());    -- 略過不算
select pg_temp.log('booking_created', 'sent', now());          -- 店家通知不算
select pg_temp.log('marketing_manual', 'sent', now());         -- 行銷不算
select pg_temp.log('customer_submitted', 'sent', now(), '32'); -- 別店不算
select public.internal_prepare_customer_line_job('c5e00000-0000-4000-8000-000000000301') as j \gset c_
select is(:'c_j'::jsonb -> 'cap_remaining', '1'::jsonb, 'Q01-3 上限 3、本月已發 2 則客人通知(上個月 / 失敗 / 略過 / 店家 / 行銷 / 別店都不算)⇒ 剩 1');
select is(pg_temp.rc(:'c_j'::jsonb), array['skip:13:monthly_cap', 'to:11'], 'Q01-4 超過的收件人(排後面的那位)移到 skipped / monthly_cap');
select ok((select bool_and(not (e ? 'to')) from jsonb_array_elements(:'c_j'::jsonb -> 'skipped') e), 'Q01-5 被略過的不帶 LINE userId');

-- 重試:已寫過 sent 的那位不重算自己
insert into line_notification_log (merchant_id, event_type, target_type, target_id, target_user_id, status, outbox_id)
values ('c5e00000-0000-4000-8000-000000000031', 'customer_confirmed', 'member', pg_temp.u('41'), pg_temp.u('11'), 'sent', 'c5e00000-0000-4000-8000-000000000301');
select is(pg_temp.rc(public.internal_prepare_customer_line_job('c5e00000-0000-4000-8000-000000000301')), array['skip:13:monthly_cap'], 'Q01-6 重試時 11 已發過不再處理;本月已發 3 則 ⇒ 13 略過');
update merchant_customer_line_settings set monthly_cap = 4 where merchant_id = 'c5e00000-0000-4000-8000-000000000031';
select is(pg_temp.rc(public.internal_prepare_customer_line_job('c5e00000-0000-4000-8000-000000000301')), array['to:13'], 'Q01-7 上限 4 ⇒ 重試時 13 可以發(不會把已發的 11 算兩次)');
update merchant_customer_line_settings set monthly_cap = 1 where merchant_id = 'c5e00000-0000-4000-8000-000000000031';
select is(public.internal_prepare_customer_line_job(pg_temp.ob('00302', 'store_booking_created')) -> 'cap_remaining', 'null'::jsonb, 'Q01-8 店家那邊(store_*)不受客人通知上限影響');
select is(pg_temp.rc(public.internal_prepare_customer_line_job('c5e00000-0000-4000-8000-000000000302')), array['to:admin'], 'Q01-9 ⇒ 管理員照收');

-- =========================================================================
-- K02 每月上限設定
-- =========================================================================
select pg_temp.as_user('c5e00000-0000-4000-8000-000000000001');
select is(public.set_customer_line_monthly_cap('c5e00000-0000-4000-8000-000000000031', 150) -> 'settings' -> 'monthly_cap', '150'::jsonb, 'K02-1 管理員設上限 150');
select is(public.get_customer_line_settings('c5e00000-0000-4000-8000-000000000031') -> 'settings' -> 'monthly_cap', '150'::jsonb, 'K02-2 讀回 150');
select is(pg_temp.err($$select public.set_customer_line_monthly_cap('c5e00000-0000-4000-8000-000000000031', 0)$$), '22023:monthly_cap_invalid', 'K02-3 0 被拒');
select is(pg_temp.err($$select public.set_customer_line_monthly_cap('c5e00000-0000-4000-8000-000000000031', 100001)$$), '22023:monthly_cap_invalid', 'K02-4 超過 100000 被拒');
select is(pg_temp.err($$select public.update_customer_line_settings('c5e00000-0000-4000-8000-000000000031', '{"monthly_cap": 10}')$$), '22023:invalid_patch', 'K02-5 一般設定函式仍不收 monthly_cap');
select is(public.set_customer_line_monthly_cap('c5e00000-0000-4000-8000-000000000031', null) -> 'settings' -> 'monthly_cap', 'null'::jsonb, 'K02-6 留空 = 不限制');
select is(pg_temp.err($$select public.set_customer_line_monthly_cap('c5e00000-0000-4000-8000-000000000032', 10)$$), '42501:forbidden', 'K02-7 別店的管理員權限不通用');
select pg_temp.as_user('c5e00000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select public.set_customer_line_monthly_cap('c5e00000-0000-4000-8000-000000000031', 10)$$), '42501:forbidden', 'K02-8 有「LINE 通知」權限的客服也不能改上限 ⚠️');
select is(pg_temp.err($$select public.get_customer_line_settings('c5e00000-0000-4000-8000-000000000031')$$), 'ok', 'K02-9 (對照)這位客服可以看設定');

-- =========================================================================
-- Q02 本月用量
-- =========================================================================
select is(public.get_customer_line_usage('c5e00000-0000-4000-8000-000000000031') -> 'by_category',
          '{"customer": 3, "store": 1, "marketing": 1, "birthday": 0}'::jsonb, 'Q02-1 有 LINE 通知權限的客服看得到本月分類統計(只算 sent、本月)');
select pg_temp.as_user('c5e00000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select public.get_customer_line_usage('c5e00000-0000-4000-8000-000000000031')$$), '42501:forbidden', 'Q02-2 沒權限的客服 ⇒ 42501');
select pg_temp.as_anon();
select is(pg_temp.err($$select public.get_customer_line_usage('c5e00000-0000-4000-8000-000000000031')$$), '42501:', 'Q02-3 anon 不能執行');
select pg_temp.as_user('c5e00000-0000-4000-8000-000000000001');
select public.get_customer_line_usage('c5e00000-0000-4000-8000-000000000031') as j \gset g_
select is(array[:'g_j'::jsonb ->> 'connected', :'g_j'::jsonb ->> 'total_sent', :'g_j'::jsonb ->> 'month'],
          array['true', '5', to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM')], 'Q02-4 管理員:connected、合計、月份');
select ok(:'g_j'::text not like '%SENTINEL%' and :'g_j'::text not like '%SECRET%', 'Q02-5 回應不含 token / secret');
select pg_temp.as_postgres();

-- =========================================================================
-- Q04 80% 鈴鐺
-- =========================================================================
select is(public.internal_line_quota_check_due('c5e00000-0000-4000-8000-000000000031'), true, 'Q04-1 第一次 ⇒ 該查了');
select is(public.internal_line_quota_check_due('c5e00000-0000-4000-8000-000000000031'), false, 'Q04-2 一小時內再問 ⇒ 不用查 ⚠️');
update merchant_customer_line_settings set quota_checked_at = now() - interval '61 minutes' where merchant_id = 'c5e00000-0000-4000-8000-000000000031';
select is(public.internal_line_quota_check_due('c5e00000-0000-4000-8000-000000000031'), true, 'Q04-3 超過一小時 ⇒ 又該查了');
select is(public.internal_line_quota_warning('c5e00000-0000-4000-8000-000000000031', 159, 200), false, 'Q04-4 79.5% ⇒ 不發');
select is(public.internal_line_quota_warning('c5e00000-0000-4000-8000-000000000031', 170, 200), true, 'Q04-5 85% ⇒ 發');
select is((select array_agg(user_id::text || '|' || title || '|' || body) from user_notifications
           where merchant_id = 'c5e00000-0000-4000-8000-000000000031' and event_type = 'line_quota_warning'),
          array['c5e00000-0000-4000-8000-000000000001|LINE 訊息額度快用完了|本月 LINE 訊息額度已用 85%（170／200 則）。用完後這個月的 LINE 通知（包含員工通知）都會發送失敗。'],
          'Q04-6 只給管理員(客服不收 ⚠️)、全形標點、照實際百分比');
select is(public.internal_line_quota_warning('c5e00000-0000-4000-8000-000000000031', 190, 200), false, 'Q04-7 同月只發一則');
select is((select quota_warned_month from merchant_customer_line_settings where merchant_id = 'c5e00000-0000-4000-8000-000000000031'),
          to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM'), 'Q04-8 記下本月已提醒');
insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body)
values ('c5e00000-0000-4000-8000-000000000001', 'c5e00000-0000-4000-8000-000000000032', 'admin', gen_random_uuid(), 'line_quota_exhausted', 't', 'b');
select is(public.internal_line_quota_warning('c5e00000-0000-4000-8000-000000000032', 199, 200), false, 'Q04-9 本月已發過「用完」⇒ 不再發 80%');

-- =========================================================================
-- P01 行銷
-- =========================================================================
insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at) values
  ('c5e00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5e013', false, 'webhook', now());
select pg_temp.as_user('c5e00000-0000-4000-8000-000000000004');
select public.preview_line_marketing_recipients('c5e00000-0000-4000-8000-000000000031',
  array[pg_temp.u('41'), pg_temp.u('42'), pg_temp.u('43'), pg_temp.u('44'), pg_temp.u('45')]) as j \gset p_
select is(:'p_j'::jsonb -> 'members',
          jsonb_build_array(
            jsonb_build_object('member_id', pg_temp.u('41'), 'recipient_count', 1),
            jsonb_build_object('member_id', pg_temp.u('42'), 'recipient_count', 0),
            jsonb_build_object('member_id', pg_temp.u('43'), 'recipient_count', 1),
            jsonb_build_object('member_id', pg_temp.u('44'), 'recipient_count', 0)),
          'P01-1 公司會員:11 收、12 關優惠、13 非好友 ⇒ 1;個人會員關優惠 ⇒ 0;舊綁定碼 ⇒ 1;黑名單 ⇒ 0;別店會員不出現');
select is(array[(:'p_j'::jsonb ->> 'member_count'), (:'p_j'::jsonb ->> 'message_count')], array['2', '2'], 'P01-2 確認窗:2 位會員、共 2 則');
select ok(:'p_j'::text not like '%U000000000%', 'P01-3 預覽不含 LINE userId');
select pg_temp.as_postgres();
delete from customer_line_friendships where merchant_id = 'c5e00000-0000-4000-8000-000000000031';
select pg_temp.as_user('c5e00000-0000-4000-8000-000000000004');
select is(public.preview_line_marketing_recipients('c5e00000-0000-4000-8000-000000000031', array[pg_temp.u('41')]) ->> 'message_count',
          '2', 'P01-4 13 不再是已知非好友 ⇒ 公司會員 2 則(多聯絡人各一則)');
select pg_temp.as_user('c5e00000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select public.preview_line_marketing_recipients('c5e00000-0000-4000-8000-000000000031', array[]::uuid[])$$), '42501:forbidden',
          'P01-5 只有 LINE 通知權限、沒有行銷權限的客服 ⇒ 42501(同行銷權限)');
select pg_temp.as_postgres();
select is((select jsonb_agg(c ->> 'line_user_id' order by c ->> 'user_id') from jsonb_array_elements(
             public.internal_line_marketing_candidates('c5e00000-0000-4000-8000-000000000031', array[pg_temp.u('44')]) -> 0 -> 'contacts') c),
          '[null]'::jsonb, 'P01-6 候選:別 channel 的身分 ⇒ line_user_id null(Edge 會記 target_not_bound)');

-- =========================================================================
-- P02 生日禮
-- =========================================================================
create function pg_temp.grant_bday(p_member text)
returns void language plpgsql as $$
declare v_tx uuid;
begin
  insert into public.member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after)
  values (pg_temp.u(p_member), 'c5e00000-0000-4000-8000-000000000031', 'birthday_bonus', 10, 10) returning id into v_tx;
  insert into public.member_birthday_bonus_grants (merchant_id, member_id, bonus_year, anchor_date, points, point_transaction_id, member_name_snapshot)
  values ('c5e00000-0000-4000-8000-000000000031', pg_temp.u(p_member), 2026, current_date, 10, v_tx, '生日');
end $$;
select pg_temp.grant_bday('41');
select pg_temp.grant_bday('42');
select pg_temp.grant_bday('43');
select is((select array_agg((r ->> 'member_id') || ':' || (r ->> 'line_user_id') order by r ->> 'member_id')
           from public.claim_birthday_line_pending(500) r where (r ->> 'merchant_id') = 'c5e00000-0000-4000-8000-000000000031'),
          array[pg_temp.u('41') || ':U00000000000000000000000000c5e011', pg_temp.u('43') || ':U00000000000000000000000000c5e043'],
          'P02-1 只發主要聯絡人(公司會員 ⇒ 11,不是第二聯絡人)、舊綁定碼照舊;主要關掉優惠的個人會員不回傳');
select is((select line_status || '|' || line_error from member_birthday_bonus_grants where member_id = pg_temp.u('42')),
          'skipped_opted_out|客人關閉了優惠通知，不發送生日 LINE 訊息（生日點數已照常發放）', 'P02-2 ⇒ skipped_opted_out(點數照發)');
select is((select line_status from member_birthday_bonus_grants where member_id = pg_temp.u('41')), 'pending', 'P02-3 要發的列仍是 pending(等回寫)');

-- =========================================================================
-- Q4 訪客單用到有聯絡人的會員 ⇒ 只通知主要聯絡人
-- =========================================================================
insert into bookings (id, merchant_id, staff_id, member_id, start_at, end_at, customer_name, customer_phone, source, created_by_role, status, is_guest_booking)
values (pg_temp.u('92'), 'c5e00000-0000-4000-8000-000000000031', 'c5e00000-0000-4000-8000-000000000051', pg_temp.u('41'),
        now() + interval '3 days', now() + interval '3 days 1 hour', '訪客先生', '0912550001', 'customer', 'customer', 'pending_confirmation', true);
select is((select array_agg(kind order by kind) from customer_line_outbox where booking_id = pg_temp.u('92')),
          array['customer_submitted', 'store_booking_created'], 'Q4-1 訪客單掛到會員 ⇒ 寫「收到預約」待發列(+ 店家那筆)');
update customer_line_outbox set status = 'processing', claimed_at = now() where booking_id = pg_temp.u('92') and kind = 'customer_submitted';
select is(pg_temp.rc(public.internal_prepare_customer_line_job((select id from customer_line_outbox where booking_id = pg_temp.u('92') and kind = 'customer_submitted'))),
          array['to:11'], 'Q4-2 只通知主要聯絡人(Q4=A)');

-- =========================================================================
-- QA #1 / #5:預設範本 contact_rejected 電話獨立一行;額度用完鈴鐺全形括號
-- =========================================================================
select is(private.customer_line_default_templates(false) ->> 'contact_rejected',
          '您申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。' || E'\n' || '有問題請聯絡店家：{{merchant_phone}}',
          'QA1-1 contact_rejected:電話那句是獨立一行(店家沒電話時只拿掉那行)');
select is(private.customer_line_default_templates(true) ->> 'contact_rejected', private.customer_line_default_templates(false) ->> 'contact_rejected',
          'QA1-2 到府 / 非到府同一句');
select is(public.internal_finish_customer_line_job(pg_temp.ob('00303', 'customer_confirmed'), 'quota_exhausted', null) ->> 'state', 'quota_exhausted', 'QA5-1 LINE 額度用完');
select is((select array_agg(body) from user_notifications where merchant_id = 'c5e00000-0000-4000-8000-000000000031' and event_type = 'line_quota_exhausted'),
          array['LINE 官方帳號本月訊息額度已用完，這個月的 LINE 通知（包含員工通知）都會發送失敗，下個月 1 日自動恢復。'],
          'QA5-2 額度用完鈴鐺內文全形括號');

-- =========================================================================
-- X01 權限
-- =========================================================================
select is((select array_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'execute') || ':' || has_function_privilege('authenticated', p.oid, 'execute')
                            || ':' || has_function_privilege('service_role', p.oid, 'execute') order by p.proname)
           from pg_proc p where p.oid in (
             'public.set_customer_line_monthly_cap(uuid, integer)'::regprocedure,
             'public.get_customer_line_usage(uuid)'::regprocedure,
             'public.internal_line_quota_check_due(uuid)'::regprocedure,
             'public.internal_line_quota_warning(uuid, integer, integer)'::regprocedure,
             'public.preview_line_marketing_recipients(uuid, uuid[])'::regprocedure,
             'public.internal_line_marketing_candidates(uuid, uuid[])'::regprocedure,
             'public.internal_prepare_customer_line_job(uuid)'::regprocedure,
             'public.claim_birthday_line_pending(integer)'::regprocedure)),
          array['claim_birthday_line_pending:false:false:true',
                'get_customer_line_usage:false:true:true',
                'internal_line_marketing_candidates:false:false:true',
                'internal_line_quota_check_due:false:false:true',
                'internal_line_quota_warning:false:false:true',
                'internal_prepare_customer_line_job:false:false:true',
                'preview_line_marketing_recipients:false:true:true',
                'set_customer_line_monthly_cap:false:true:true'],
          'X01-1 新 / 改版函式:internal_* 只給 service_role;後台函式 anon 不可、authenticated 可(函式內擋權限;service_role 同 5-A 慣例保留)');
select is((select count(*)::int from pg_proc p
           where p.oid in ('private.line_marketing_candidates(uuid, uuid[])'::regprocedure, 'private.customer_line_month_sent(uuid)'::regprocedure)
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))),
          0, 'X01-2 private 新函式全部收回');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proacl is null
             and p.proname in ('set_customer_line_monthly_cap', 'get_customer_line_usage', 'internal_line_quota_check_due',
                               'internal_line_quota_warning', 'preview_line_marketing_recipients', 'internal_line_marketing_candidates')),
          0, 'X01-3 沒有任何一支停在預設權限(PUBLIC 可執行)');
select is((select count(*)::int from pg_policy p join pg_roles r on r.oid = any (p.polroles) where r.rolname = 'anon'),
          0, 'X01-4 全庫 anon policy 仍為 0(鐵律 1)');
select is((select pg_get_constraintdef(oid) like '%skipped_opted_out%' and pg_get_constraintdef(oid) like '%skipped_merchant_disabled%'
           from pg_constraint where conname = 'member_birthday_bonus_grants_line_status_check'),
          true, 'X01-5 生日 line_status 新值加上、舊值保留');

select * from finish();
rollback;
