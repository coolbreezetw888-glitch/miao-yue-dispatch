-- 客戶端第 5-A 批 — 客人開關、會員中心 / 公開頁 / 完成頁、後台設定 / 發送記錄 / 聯絡人卡(C5-M01~M04、K01~K03、F03、X01、X03、X04)
-- 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md
begin;

select plan(55);

create function pg_temp.as_customer(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated',
    'app_metadata', json_build_object('account_type', 'customer'))::text, true);
  set local role authenticated;
end;
$$;
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
grant execute on function pg_temp.as_customer(uuid) to anon, authenticated, service_role;
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

create temp table o (label text primary key, body jsonb);
grant all on o to anon, authenticated, service_role;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c5c00000-0000-4000-8000-000000000001', 'pgtap-c5c-admin@test.local', '{}'::jsonb),
  ('c5c00000-0000-4000-8000-000000000002', 'pgtap-c5c-agent-line@test.local', '{}'::jsonb),
  ('c5c00000-0000-4000-8000-000000000003', 'pgtap-c5c-agent-none@test.local', '{}'::jsonb),
  ('c5c00000-0000-4000-8000-000000000004', 'pgtap-c5c-other-admin@test.local', '{}'::jsonb);
insert into auth.users (id, email, raw_app_meta_data)
select ('c5c00000-0000-4000-8000-0000000000' || s)::uuid, 'line-pgtap-c5c-' || s || '@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb
from unnest(array['11','12','13']) s;

insert into groups (id) values ('c5c00000-0000-4000-8000-000000000091'), ('c5c00000-0000-4000-8000-000000000092');
insert into merchants (id, group_id, name, industry_type, booking_slug, status, line_friend_url) values
  ('c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000091', 'C5C店', 'in_store_beauty', 'pgtap-c5c', 'active', 'https://lin.ee/c5cfallback'),
  ('c5c00000-0000-4000-8000-000000000032', 'c5c00000-0000-4000-8000-000000000092', 'C5C別集團店', 'in_store_beauty', 'pgtap-c5c-x', 'active', null);
insert into merchant_admins (merchant_id, user_id) values
  ('c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000001'),
  ('c5c00000-0000-4000-8000-000000000032', 'c5c00000-0000-4000-8000-000000000004');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c5c00000-0000-4000-8000-000000000071', 'c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000002', 'LINE客服', '0900530071', 'pgtap-c5c-agent-line@test.local', 'active'),
  ('c5c00000-0000-4000-8000-000000000072', 'c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000003', '沒權限客服', '0900530072', 'pgtap-c5c-agent-none@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c5c00000-0000-4000-8000-000000000071', 'line_notification', true),
  ('c5c00000-0000-4000-8000-000000000071', 'members', true),
  ('c5c00000-0000-4000-8000-000000000072', 'members', true);
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c5c00000-0000-4000-8000-000000000031', '5454545454', vault.create_secret('C5CFAKESECRET0000000000000000AA'), '00AA', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name) values
  ('c5c00000-0000-4000-8000-000000000011', '5454545454', 'U00000000000000000000000000c5c011', '主要LINE名'),
  ('c5c00000-0000-4000-8000-000000000012', '5454545454', 'U00000000000000000000000000c5c012', '第二LINE名'),
  ('c5c00000-0000-4000-8000-000000000013', '5454545454', 'U00000000000000000000000000c5c013', '別人LINE名');
insert into members (id, merchant_id, name, phone, referral_code) values
  ('c5c00000-0000-4000-8000-000000000041', 'c5c00000-0000-4000-8000-000000000031', '公司會員', '0912530001', 'C5CREF41'),
  ('c5c00000-0000-4000-8000-000000000042', 'c5c00000-0000-4000-8000-000000000031', '別的會員', '0912530002', 'C5CREF42'),
  ('c5c00000-0000-4000-8000-000000000043', 'c5c00000-0000-4000-8000-000000000031', '舊綁定會員', '0912530003', 'C5CREF43');
update members set line_bound = true, line_user_id = 'U00000000000000000000000000c5c043' where id = 'c5c00000-0000-4000-8000-000000000043';
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via) values
  ('c5c00000-0000-4000-8000-000000000081', 'c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000041', 'c5c00000-0000-4000-8000-000000000011', true, 'backfill'),
  ('c5c00000-0000-4000-8000-000000000082', 'c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000041', 'c5c00000-0000-4000-8000-000000000012', false, 'invite'),
  ('c5c00000-0000-4000-8000-000000000083', 'c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000042', 'c5c00000-0000-4000-8000-000000000013', true, 'backfill');

-- =========================================================================
-- M03 / M01:店還沒接上官方帳號
-- =========================================================================
select pg_temp.as_customer('c5c00000-0000-4000-8000-000000000012');
insert into o values ('p0', public.customer_get_notify_prefs('pgtap-c5c'));
select pg_temp.as_postgres();
select is((select body from o where label = 'p0'),
          '{"state":"ok","available":false,"notify_booking":true,"notify_promo":true,"friend_status":"unknown","add_friend_url":"https://lin.ee/c5cfallback"}'::jsonb,
          'M03-1 沒接上官方帳號 ⇒ available false;預設兩個開關開;沒有 @ID ⇒ 用 line_friend_url');

insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected, line_bot_basic_id) values
  ('c5c00000-0000-4000-8000-000000000031', '1234567894', 'C5C-SECRET-SENTINEL', 'C5C-TOKEN-SENTINEL', true, '@c5c.shop');
insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at) values
  ('c5c00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5c012', false, 'webhook', now()),
  ('c5c00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5c011', true, 'login', now());

select pg_temp.as_customer('c5c00000-0000-4000-8000-000000000012');
insert into o values ('p1', public.customer_get_notify_prefs('pgtap-c5c'));
insert into o values ('s1', public.customer_set_notify_prefs('pgtap-c5c', false, null));
insert into o values ('s2', public.customer_set_notify_prefs('pgtap-c5c', null, false));
insert into o values ('h1', public.customer_get_member_home('pgtap-c5c'));
select pg_temp.as_customer('c5c00000-0000-4000-8000-000000000011');
insert into o values ('p2', public.customer_get_notify_prefs('pgtap-c5c'));
insert into o values ('h2', public.customer_get_member_home('pgtap-c5c'));
insert into o values ('x1', public.customer_get_notify_prefs('pgtap-c5c-x'));
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000001');
insert into o values ('x2', public.customer_get_notify_prefs('pgtap-c5c'));
insert into o values ('x3', public.customer_set_notify_prefs('pgtap-c5c', false, false));
select pg_temp.as_postgres();

select is((select body from o where label = 'p1'),
          '{"state":"ok","available":true,"notify_booking":true,"notify_promo":true,"friend_status":"not_friend","add_friend_url":"https://line.me/R/ti/p/%40c5c.shop"}'::jsonb,
          'M03-2 接上後:available true、第二聯絡人看到自己的好友狀態、@ID 網址編碼');
select is((select body ->> 'notify_booking' || ',' || (body ->> 'notify_promo') from o where label = 's1'), 'false,true', 'M03-3 只關預約通知;優惠傳 null = 不變');
select is((select body ->> 'notify_booking' || ',' || (body ->> 'notify_promo') from o where label = 's2'), 'false,false', 'M03-4 再關優惠通知;預約傳 null = 不變');
select is((select notify_booking::text || ',' || notify_promo::text || ',' || (notify_prefs_updated_at is not null)::text
           from member_customer_contacts where id = 'c5c00000-0000-4000-8000-000000000082'), 'false,false,true', 'M03-5 寫進自己那列');
select is((select notify_booking::text || ',' || notify_promo::text from member_customer_contacts where id = 'c5c00000-0000-4000-8000-000000000081'),
          'true,true', 'M03-6 主要聯絡人的開關沒被動到(每人各自設定)');
select is((select body ->> 'friend_status' || ',' || (body ->> 'notify_booking') from o where label = 'p2'), 'friend,true', 'M03-7 主要聯絡人看到自己的(friend、開)');
select is((select body -> 'line_notify' from o where label = 'h1'),
          '{"available":true,"notify_booking":false,"friend_status":"not_friend","add_friend_url":"https://line.me/R/ti/p/%40c5c.shop"}'::jsonb,
          'M01-1 會員中心首頁 line_notify(第二聯絡人)');
select is((select array_agg(k order by k) from o, jsonb_object_keys(body -> 'line_notify') k where label = 'h2'),
          array['add_friend_url', 'available', 'friend_status', 'notify_booking'], 'M01-2 line_notify 白名單 4 個 key');
select is((select body from o where label = 'x1'), '{"state":"unavailable"}'::jsonb, 'X04-1 別店代碼(沒啟用 LINE 登入)⇒ unavailable,不回任何東西');
select is((select body from o where label = 'x2'), '{"state":"not_linked"}'::jsonb, 'M03-8 後台帳號(不是客人)⇒ not_linked');
select is((select body from o where label = 'x3'), '{"state":"not_linked"}'::jsonb, 'M03-9 後台帳號改不了任何人的開關');
select is((select count(*)::int from o where body::text ~ 'U[0-9a-f]{32}' or body::text ilike '%TOKEN%' or body::text ilike '%SECRET%'), 0,
          'X03-1 客人函式回應搜不到 LINE userId / token / secret');
select ok((select body::text not like '%第二LINE名%' and body::text not like '%主要LINE名%' from o where label = 'h2'),
          'X03-2 會員中心首頁不回聯絡人的 LINE 顯示名(別人的狀態)');

select pg_temp.as_anon();
select is(left(pg_temp.err($$select public.customer_get_notify_prefs('pgtap-c5c')$$), 5), '42501', 'X01-1 anon 不能呼叫 customer_get_notify_prefs');
select is(left(pg_temp.err($$select public.customer_set_notify_prefs('pgtap-c5c', true, true)$$), 5), '42501', 'X01-2 anon 不能呼叫 customer_set_notify_prefs');
select pg_temp.as_postgres();

-- =========================================================================
-- M04 公開頁 / 完成頁預設句
-- =========================================================================
select is((public.get_public_booking_page('pgtap-c5c') -> 'booking_settings' ->> 'line_notify_available'), 'true', 'M04-1 公開頁 line_notify_available = true');
select is((public.get_public_booking_page('pgtap-c5c-x') -> 'booking_settings' ->> 'line_notify_available'), 'false', 'M04-2 沒接上的店 ⇒ false');
select is(private.default_member_completion_message('c5c00000-0000-4000-8000-000000000031', 'pending_confirmation'), '店家確認後會用 LINE 通知你。',
          'M04-3 能用 LINE 通知 + 店家確認開著 ⇒「會用 LINE 通知你」');
select is(private.default_member_completion_message('c5c00000-0000-4000-8000-000000000031', 'accepted'), '服務前店家可能會再跟你聯絡確認。',
          'M04-4 直接成立的句子不變');
select is(private.default_member_completion_message('c5c00000-0000-4000-8000-000000000032', 'pending_confirmation'), '店家確認後會通知你。',
          'M04-5 沒接上官方帳號 ⇒ 維持原句');
insert into merchant_customer_line_settings (merchant_id, on_confirmed) values ('c5c00000-0000-4000-8000-000000000031', false);
select is(private.default_member_completion_message('c5c00000-0000-4000-8000-000000000031', 'pending_confirmation'), '店家確認後會通知你。',
          'M04-6 「店家確認」通知關掉 ⇒ 維持原句');
update merchant_customer_line_settings set on_confirmed = true where merchant_id = 'c5c00000-0000-4000-8000-000000000031';
-- 完成頁實際輸出(會員待確認 / 店家自訂不動)
insert into merchant_staff (id, merchant_id, name, status, login_status, phone) values
  ('c5c00000-0000-4000-8000-000000000051', 'c5c00000-0000-4000-8000-000000000031', '服務人員', 'active', 'not_invited', '0900530051');
insert into bookings (id, merchant_id, staff_id, member_id, start_at, end_at, customer_name, customer_phone, source, created_by_role, status) values
  ('c5c00000-0000-4000-8000-000000000201', 'c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000051', 'c5c00000-0000-4000-8000-000000000041',
   now() + interval '2 days', now() + interval '2 days 1 hour', '客', '0912530001', 'customer', 'customer', 'pending_confirmation');
select is(private.customer_booking_result('c5c00000-0000-4000-8000-000000000201') ->> 'completion_message', '店家確認後會用 LINE 通知你。', 'M04-7 完成頁:會員待確認 ⇒ 新預設句');
insert into merchant_booking_settings (merchant_id, completion_message_member) values ('c5c00000-0000-4000-8000-000000000031', '店家自訂完成句');
select is(private.customer_booking_result('c5c00000-0000-4000-8000-000000000201') ->> 'completion_message', '店家自訂完成句', 'M04-8 店家自訂的文字不動');

-- =========================================================================
-- K02 設定函式
-- =========================================================================
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000002');
insert into o values ('k1', public.get_customer_line_settings('c5c00000-0000-4000-8000-000000000031'));
insert into o values ('k2', public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031',
  '{"on_reminder":true,"reminder_hours_before":12,"templates":{"confirmed":"  自訂確認文字  ","rescheduled":"改時間"}}'::jsonb));
insert into o values ('k3', public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"templates":{"rescheduled":""}}'::jsonb));
insert into o values ('k4', to_jsonb(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"monthly_cap":100}'::jsonb)$$)));
select pg_temp.as_postgres();
select is((select body -> 'settings' from o where label = 'k1') - 'updated_at',
          '{"on_submitted":true,"on_scheduled_by_store":false,"on_confirmed":true,"on_rescheduled":true,"on_cancelled_by_store":true,"on_cancelled_by_customer":true,"on_reminder":false,"on_completed":false,"on_contact_events":true,"reminder_hours_before":24,"monthly_cap":null,"quota_blocked_until":null}'::jsonb,
          'K02-1 有 LINE 權限的客服讀得到;預設值(Q1=A)');
select is((select array[body ->> 'connected', body ->> 'line_login_enabled', body ->> 'is_on_site', body ->> 'is_admin',
                        jsonb_array_length(body -> 'template_codes')::text, (select count(*)::text from jsonb_object_keys(body -> 'default_templates'))]
           from o where label = 'k1'),
          array['true', 'true', 'false', 'false', '13', '13'], 'K02-2 狀態欄位 + 13 個範本代碼與預設文字');
select is((select array[body -> 'settings' ->> 'on_reminder', body -> 'settings' ->> 'reminder_hours_before', body -> 'templates' ->> 'confirmed', body -> 'templates' ->> 'rescheduled'] from o where label = 'k2'),
          array['true', '12', '自訂確認文字', '改時間'], 'K02-3 改開關 / 提醒時數 / 範本(去頭尾空白)');
select is((select body -> 'templates' from o where label = 'k3'), '{"confirmed":"自訂確認文字"}'::jsonb, 'K02-4 空字串 = 恢復預設(只刪那個鍵,其他保留)');
select is((select updated_by_user_id from merchant_customer_line_settings where merchant_id = 'c5c00000-0000-4000-8000-000000000031'),
          'c5c00000-0000-4000-8000-000000000002'::uuid, 'K02-5 記錄是誰改的');
select is((select body #>> '{}' from o where label = 'k4'), '22023:invalid_patch', 'K02-6 monthly_cap 不能從這支改(5-B 另一支只給管理員)');

select pg_temp.as_user('c5c00000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"templates":{"nope":"x"}}')$$), '22023:template_code_invalid', 'K02-7 不認得的範本代碼');
select is(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', jsonb_build_object('templates', jsonb_build_object('confirmed', repeat('字', 501))))$$), '22023:template_too_long', 'K02-8 範本超過 500 字');
select is(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"reminder_hours_before":5}')$$), '22023:reminder_hours_invalid', 'K02-9 提醒時數只收 2/3/6/12/24/48');
select is(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"on_confirmed":"yes"}')$$), '22023:invalid_patch', 'K02-10 開關型別不對');
select is(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"whatever":true}')$$), '22023:invalid_patch', 'K02-11 不認得的鍵');
select is((public.get_customer_line_settings('c5c00000-0000-4000-8000-000000000031') ->> 'is_admin'), 'true', 'K02-12 管理員 is_admin true');
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select public.get_customer_line_settings('c5c00000-0000-4000-8000-000000000031')$$), '42501:forbidden', 'K02-13 沒有 LINE 通知權限的客服看不到');
select is(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"on_confirmed":false}')$$), '42501:forbidden', 'K02-14 沒有權限的客服改不了');
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000004');
select is(pg_temp.err($$select public.get_customer_line_settings('c5c00000-0000-4000-8000-000000000031')$$), '42501:forbidden', 'X04-2 別店管理員讀不到');
select pg_temp.as_customer('c5c00000-0000-4000-8000-000000000011');
select is(pg_temp.err($$select public.update_customer_line_settings('c5c00000-0000-4000-8000-000000000031', '{"on_confirmed":false}')$$), '42501:forbidden', 'X04-3 客人帳號改不了');
select pg_temp.as_postgres();
select ok((select (s.templates ->> 'confirmed') = '自訂確認文字' and s.on_confirmed from merchant_customer_line_settings s where merchant_id = 'c5c00000-0000-4000-8000-000000000031'),
          'K02-15 被擋的呼叫都沒改到資料');

-- =========================================================================
-- K03 發送記錄
-- =========================================================================
insert into line_notification_log (merchant_id, event_type, target_type, target_id, target_line_user_id, target_user_id, status, outbox_id, attempted_at) values
  ('c5c00000-0000-4000-8000-000000000031', 'customer_confirmed', 'member', 'c5c00000-0000-4000-8000-000000000041', 'U00000000000000000000000000c5c012',
   'c5c00000-0000-4000-8000-000000000012', 'sent', gen_random_uuid(), now()),
  ('c5c00000-0000-4000-8000-000000000031', 'booking_created', 'admin', gen_random_uuid(), 'UadminVisible', null, 'sent', null, now() - interval '1 minute'),
  ('c5c00000-0000-4000-8000-000000000031', 'marketing_manual', 'member', 'c5c00000-0000-4000-8000-000000000043', 'U00000000000000000000000000c5c043', null, 'sent', null, now() - interval '2 minutes');
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000002');
insert into o select 'l_all', jsonb_agg(to_jsonb(t) order by t.attempted_at desc) from public.get_line_notification_log('c5c00000-0000-4000-8000-000000000031') t;
insert into o select 'l_cus', jsonb_agg(t.event_type) from public.get_line_notification_log('c5c00000-0000-4000-8000-000000000031', null, 50, 0, 'customer') t;
insert into o select 'l_sto', jsonb_agg(t.event_type) from public.get_line_notification_log('c5c00000-0000-4000-8000-000000000031', p_category => 'store') t;
select is(pg_temp.err($$select * from public.get_line_notification_log('c5c00000-0000-4000-8000-000000000031', p_category => 'nope')$$), '22023:invalid_category', 'K03-1 分類亂值被拒');
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000003');
select is(left(pg_temp.err($$select * from public.get_line_notification_log('c5c00000-0000-4000-8000-000000000031')$$), 6), '42501:', 'K03-2 沒權限的客服看不到發送記錄(行為不變)');
select pg_temp.as_postgres();
select is((select jsonb_build_object('n', body -> 0 ->> 'target_member_name', 'c', body -> 0 ->> 'target_contact_display_name',
                                     'u', body -> 0 ->> 'target_line_user_id', 'tu', body -> 0 ->> 'target_user_id') from o where label = 'l_all'),
          '{"n":"公司會員","c":"第二LINE名","u":null,"tu":"c5c00000-0000-4000-8000-000000000012"}'::jsonb,
          'K03-3 客人通知:會員姓名 + 聯絡人 LINE 顯示名;不回客人的 LINE userId');
select is((select array[body -> 1 ->> 'target_line_user_id', body -> 1 ->> 'target_member_name', body -> 2 ->> 'target_line_user_id', body -> 2 ->> 'target_member_name'] from o where label = 'l_all'),
          array['UadminVisible', null, null, '舊綁定會員'], 'K03-4 店家對象照舊回 userId;會員對象(行銷)一律遮掉');
select is((select array[(select body from o where label = 'l_cus'), (select body from o where label = 'l_sto')]),
          array['["customer_confirmed"]'::jsonb, '["booking_created"]'::jsonb], 'K03-5 分類篩選 customer / store');
select is((select array_agg(a::text order by a::text) from pg_proc, unnest(proacl) a where oid = 'public.get_line_notification_log(uuid,text,integer,integer,text)'::regprocedure),
          array['authenticated=X/postgres', 'postgres=X/postgres', 'service_role=X/postgres'], 'K03-6 換簽章後 ACL 整組重寫(沒有 PUBLIC / anon)');
select is((select count(*)::int from pg_proc where proname = 'get_line_notification_log'), 1, 'K03-7 舊簽章已 drop');

-- =========================================================================
-- F03 聯絡人卡 / K01
-- =========================================================================
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000002');
insert into o values ('c1', public.list_member_contacts('c5c00000-0000-4000-8000-000000000041'));
insert into o values ('c2', public.list_member_contacts('c5c00000-0000-4000-8000-000000000043'));
select pg_temp.as_postgres();
select is((select jsonb_agg(jsonb_build_object('f', e ->> 'line_friend_status', 'b', e -> 'notify_booking', 'p', e -> 'notify_promo') order by ord)
           from o, jsonb_array_elements(body -> 'contacts') with ordinality t(e, ord) where label = 'c1'),
          '[{"f":"friend","b":true,"p":true},{"f":"not_friend","b":false,"p":false}]'::jsonb, 'F03-1 每位聯絡人:好友狀態 + 兩個開關(唯讀)');
select is((select body -> 'legacy_line' from o where label = 'c1'), 'null'::jsonb, 'F03-2 有聯絡人 ⇒ legacy_line null');
select is((select body -> 'legacy_line' from o where label = 'c2'), '{"friend_status":"unknown"}'::jsonb, 'F03-3 舊綁定碼會員 ⇒ 顯示好友狀態');
select is((select count(*)::int from o where label in ('c1', 'c2') and body::text ~ 'U[0-9a-f]{32}'), 0, 'F03-4 聯絡人卡不回 LINE userId');

-- K01:notify_member 打開也不回會員
insert into merchant_line_event_settings (merchant_id, event_type, enabled, notify_admin, notify_agent, notify_staff, notify_member, message_template) values
  ('c5c00000-0000-4000-8000-000000000031', 'booking_confirmed', true, false, false, false, true, 'x');
update members set line_bound = true, line_user_id = 'U00000000000000000000000000c5c041' where id = 'c5c00000-0000-4000-8000-000000000041';
select is((select count(*)::int from jsonb_array_elements(public.resolve_line_notification_targets('c5c00000-0000-4000-8000-000000000031', 'booking_confirmed', 'c5c00000-0000-4000-8000-000000000201', null) -> 'targets') t
           where t ->> 'type' = 'member')
        + (select count(*)::int from jsonb_array_elements(public.resolve_line_notification_targets('c5c00000-0000-4000-8000-000000000031', 'booking_confirmed', 'c5c00000-0000-4000-8000-000000000201', null) -> 'skipped') t
           where t ->> 'type' = 'member'),
          0, 'K01-1 notify_member = true、會員也綁了 LINE ⇒ 模組 11 不回會員(targets / skipped 都沒有)');
select pg_temp.as_user('c5c00000-0000-4000-8000-000000000001');
select is((select count(*)::int from jsonb_array_elements(public.preview_line_notification_targets('c5c00000-0000-4000-8000-000000000201', 'booking_confirmed') -> 'targets') t
           where t ->> 'type' = 'member'), 0, 'K01-2 確認彈窗預覽也不列會員');
select pg_temp.as_postgres();

select is((select array_agg(p.proname || '=' || (select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a) order by p.proname) from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname in ('customer_get_notify_prefs', 'customer_set_notify_prefs',
             'get_customer_line_settings', 'update_customer_line_settings')),
          array['customer_get_notify_prefs=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres',
                'customer_set_notify_prefs=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres',
                'get_customer_line_settings=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres',
                'update_customer_line_settings=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'],
          'X01-3 客人 / 後台新函式:authenticated(函式內擋身分 / 權限)+ service_role;沒有 PUBLIC / anon');

select * from finish();
rollback;
