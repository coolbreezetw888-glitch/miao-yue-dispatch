-- 客戶端第 4-A 批 — 會員中心(C4-A01、A02、A03、A04、C01、C03、E01、E03、E05、K02、F02、F03)
-- 規格書 .project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」優先)
--
--   A01  取消期限欄位 check / 預設 / 保護 trigger(客服改被擋、管理員可改);鈴鐺新事件;members.address 長度
--   A02  身分判斷:linked / 別的 channel / 沒接上 / 不是客人帳號 / 會員被下架 / 店家停用 / 沒啟用 LINE 登入 / 別家店
--   A03  BookingView 欄位白名單、pending_reply ⇒ pending_confirmation、can_cancel / 期限
--   A04  update_member 地址:不帶 = 不變、'' = 清掉、超過 200 字擋;舊 7 參數呼叫不清地址
--   C01  首頁:next_booking、upcoming_count、missing、wallet(紅利開 / 關)
--   C03  我的預約:upcoming / history 範圍與排序、游標分頁不重複不漏(含同一個開始時間)、counts、invalid_scope、別人的單看不到
--   E01  我的資料;E03 修改每個分支 + 其他欄位不動;E05 session state 多 address;K02 公開頁多 customer_cancel_deadline_hours
--   F02  哨兵:內部備註、服務人員本名 / 電話、會員 notes、黑名單原因、line_user_id、其他會員姓名搜不到
begin;

select plan(86);

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
create function pg_temp.as_postgres()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
grant execute on function pg_temp.as_customer(uuid) to authenticated;
grant execute on function pg_temp.as_user(uuid) to authenticated;
grant execute on function pg_temp.as_postgres() to authenticated;

-- 以 sqlstate:hint 形式回傳錯誤
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
grant execute on function pg_temp.err(text) to authenticated;

create temp table c4m_out (label text, body jsonb);
grant all on c4m_out to authenticated;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c4a00000-0000-4000-8000-000000000001', 'pgtap-c4m-admin@test.local', '{}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000002', 'pgtap-c4m-agent@test.local', '{}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000011', 'line-c4m-11@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000012', 'line-c4m-12@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000013', 'line-c4m-13@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000014', 'line-c4m-14@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000015', 'pgtap-c4m-not-customer@test.local', '{}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000016', 'line-c4m-16@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4a00000-0000-4000-8000-000000000017', 'line-c4m-17@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb);

insert into groups (id) values ('c4a00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c4a00000-0000-4000-8000-000000000021', 'c4a00000-0000-4000-8000-000000000091', 'C4會員店', 'in_store_beauty', 'pgtap-c4m-shop', 'active'),
  ('c4a00000-0000-4000-8000-000000000022', 'c4a00000-0000-4000-8000-000000000091', 'C4沒LINE店', 'in_store_beauty', 'pgtap-c4m-noline', 'active'),
  ('c4a00000-0000-4000-8000-000000000023', 'c4a00000-0000-4000-8000-000000000091', 'C4停用店', 'in_store_beauty', 'pgtap-c4m-off', 'disabled'),
  ('c4a00000-0000-4000-8000-000000000024', 'c4a00000-0000-4000-8000-000000000091', 'C4別家店', 'in_store_beauty', 'pgtap-c4m-other', 'active');
insert into merchant_admins (merchant_id, user_id) values
  ('c4a00000-0000-4000-8000-000000000021', 'c4a00000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c4a00000-0000-4000-8000-000000000071', 'c4a00000-0000-4000-8000-000000000021', 'c4a00000-0000-4000-8000-000000000002', 'C4客服', '0900400071', 'pgtap-c4m-agent@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c4a00000-0000-4000-8000-000000000071', 'business_hours', true),
  ('c4a00000-0000-4000-8000-000000000071', 'members', true);

insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c4a00000-0000-4000-8000-000000000021', '4141414141', vault.create_secret('C4MFAKESECRET00000000000000000AA'), '00AA', true),
  ('c4a00000-0000-4000-8000-000000000023', '4343434343', vault.create_secret('C4MFAKESECRET00000000000000000BB'), '00BB', true),
  ('c4a00000-0000-4000-8000-000000000024', '4444444444', vault.create_secret('C4MFAKESECRET00000000000000000CC'), '00CC', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name, picture_url) values
  ('c4a00000-0000-4000-8000-000000000011', '4141414141', 'U-c4m-11', 'LINE小明', 'https://example.com/p11.png'),
  ('c4a00000-0000-4000-8000-000000000012', '4141414141', 'U-c4m-12', 'LINE別人', null),
  ('c4a00000-0000-4000-8000-000000000013', '9999999999', 'U-c4m-13', 'LINE錯channel', null),
  ('c4a00000-0000-4000-8000-000000000014', '4141414141', 'U-c4m-14', 'LINE沒接上', null),
  ('c4a00000-0000-4000-8000-000000000016', '4444444444', 'U-c4m-16', 'LINE別家', null),
  ('c4a00000-0000-4000-8000-000000000017', '4141414141', 'U-c4m-17', 'LINE下架', null);

insert into merchant_staff (id, merchant_id, name, nickname, phone, is_listed, status, login_status) values
  ('c4a00000-0000-4000-8000-000000000031', 'c4a00000-0000-4000-8000-000000000021', 'C4_STAFF_REALNAME_SENTINEL', '阿明', '0900999031', true, 'active', 'not_invited'),
  ('c4a00000-0000-4000-8000-000000000032', 'c4a00000-0000-4000-8000-000000000021', '本名小陳', null, '0900999032', true, 'active', 'not_invited'),
  ('c4a00000-0000-4000-8000-000000000033', 'c4a00000-0000-4000-8000-000000000024', '別家服務人員', null, '0900999033', true, 'active', 'not_invited');
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('c4a00000-0000-4000-8000-000000000081', 'c4a00000-0000-4000-8000-000000000021', '室內機清洗', 1000, 'primary', 60, 'active'),
  ('c4a00000-0000-4000-8000-000000000082', 'c4a00000-0000-4000-8000-000000000021', '加購除臭', 200, 'addon', 30, 'removed');

insert into members (id, merchant_id, name, phone, referral_code, user_id, line_user_id, notes, is_blacklisted, blacklist_reason, points_balance, email, birthday) values
  ('c4a00000-0000-4000-8000-000000000041', 'c4a00000-0000-4000-8000-000000000021', '王小明', '0912400041', 'C4MREF41',
   'c4a00000-0000-4000-8000-000000000011', 'C4_LINE_UID_SENTINEL', 'C4_MEMBER_NOTES_SENTINEL', false, 'C4_BLACKLIST_REASON_SENTINEL', 320, null, null),
  ('c4a00000-0000-4000-8000-000000000042', 'c4a00000-0000-4000-8000-000000000021', 'C4_OTHER_MEMBER_SENTINEL', '0912400042', 'C4MREF42',
   'c4a00000-0000-4000-8000-000000000012', null, null, false, null, 0, 'other@example.com', '1990-01-01'),
  ('c4a00000-0000-4000-8000-000000000043', 'c4a00000-0000-4000-8000-000000000024', '別家會員', '0912400043', 'C4MREF43',
   'c4a00000-0000-4000-8000-000000000016', null, null, false, null, 0, null, null),
  ('c4a00000-0000-4000-8000-000000000044', 'c4a00000-0000-4000-8000-000000000021', '下架會員', '0912400044', 'C4MREF44',
   'c4a00000-0000-4000-8000-000000000017', null, null, false, null, 0, null, null);
-- 第 4-B 批:接上 = 聯絡人表(members.user_id = 主要聯絡人)。直接寫 user_id 的 fixture 同步補主要聯絡人列。
insert into member_customer_contacts (merchant_id, member_id, user_id, is_primary, joined_via)
select merchant_id, id, user_id, true, 'backfill' from members
where user_id is not null and id in ('c4a00000-0000-4000-8000-000000000041', 'c4a00000-0000-4000-8000-000000000042', 'c4a00000-0000-4000-8000-000000000043', 'c4a00000-0000-4000-8000-000000000044');
update members set status = 'removed' where id = 'c4a00000-0000-4000-8000-000000000044';

-- 訂單(會員 41):b1 即將到來已確認(含內部備註哨兵)、b2 即將到來待確認(客人線上)、b3 已完成、b4 已取消(未來)、
--   b5 待確認但已結束(歷史)、b6 2 小時後(期限內不能取消)、b7 pending_reply(顯示待確認)
create temp table c4m_b (k text primary key, id uuid);
grant select on c4m_b to authenticated;
create function pg_temp.mk(p_k text, p_member uuid, p_start timestamptz, p_status text, p_source text default 'manual',
                           p_staff uuid default 'c4a00000-0000-4000-8000-000000000031')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source,
                        member_id, notes, customer_notes, customer_address, final_amount_snapshot, cancelled_at)
  values ((select merchant_id from members where id = p_member), p_staff, p_start, p_start + interval '1 hour',
          '王小明', '0912400041', case when p_source = 'customer' then 'customer' else 'admin' end, p_status, p_source,
          p_member, 'C4_INTERNAL_NOTES_SENTINEL', '客人備註', '台北市測試路 1 號', 2200,
          case when p_status = 'cancelled' then now() - interval '1 day' end)
  returning id into v;
  insert into booking_service_items (booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot) values
    (v, 'c4a00000-0000-4000-8000-000000000082', 30, 1, 200),
    (v, 'c4a00000-0000-4000-8000-000000000081', 60, 2, 1000);
  insert into c4m_b values (p_k, v);
  return v;
end $$;

select pg_temp.mk('b1', 'c4a00000-0000-4000-8000-000000000041', now() + interval '3 days', 'accepted');
select pg_temp.mk('b2', 'c4a00000-0000-4000-8000-000000000041', now() + interval '5 days', 'pending_confirmation', 'customer');
select pg_temp.mk('b3', 'c4a00000-0000-4000-8000-000000000041', now() - interval '10 days', 'completed');
select pg_temp.mk('b4', 'c4a00000-0000-4000-8000-000000000041', now() + interval '7 days', 'cancelled');
select pg_temp.mk('b5', 'c4a00000-0000-4000-8000-000000000041', now() - interval '2 days', 'pending_confirmation');
select pg_temp.mk('b6', 'c4a00000-0000-4000-8000-000000000041', now() + interval '2 hours', 'accepted', 'manual', 'c4a00000-0000-4000-8000-000000000032');
select pg_temp.mk('b7', 'c4a00000-0000-4000-8000-000000000041', now() + interval '10 days', 'pending_reply');
-- 歷史分頁用:20 張已完成(其中 h05 / h05b 同一個開始時間)
select pg_temp.mk('h' || lpad(n::text, 2, '0'), 'c4a00000-0000-4000-8000-000000000041', now() - make_interval(days => 20 + n), 'completed')
from generate_series(1, 20) n;
select pg_temp.mk('h05b', 'c4a00000-0000-4000-8000-000000000041', now() - make_interval(days => 25), 'completed');
-- 別的會員的單
select pg_temp.mk('o1', 'c4a00000-0000-4000-8000-000000000042', now() + interval '4 days', 'accepted');

-- =========================================================================
-- A01
-- =========================================================================
select is((select customer_cancel_deadline_hours from merchant_booking_settings where merchant_id = 'c4a00000-0000-4000-8000-000000000021'),
          null::integer, 'A01-0 這間店沒有設定列(讀取 coalesce 24)');
select lives_ok($$insert into merchant_booking_settings (merchant_id) values ('c4a00000-0000-4000-8000-000000000022')$$,
          'A01-1 只帶 merchant_id 新增(預設 24)不會被保護 trigger 擋');
select is((select customer_cancel_deadline_hours from merchant_booking_settings where merchant_id = 'c4a00000-0000-4000-8000-000000000022'),
          24, 'A01-2 預設 24');
select is(pg_temp.err($$update merchant_booking_settings set customer_cancel_deadline_hours = 169 where merchant_id = 'c4a00000-0000-4000-8000-000000000022'$$),
          '23514:', 'A01-3 超過 168 被 check 擋');
select is(pg_temp.err($$update merchant_booking_settings set customer_cancel_deadline_hours = -1 where merchant_id = 'c4a00000-0000-4000-8000-000000000022'$$),
          '23514:', 'A01-4 負數被 check 擋');
select pg_temp.as_user('c4a00000-0000-4000-8000-000000000002');
select is(pg_temp.err($$insert into merchant_booking_settings (merchant_id, customer_cancel_deadline_hours) values ('c4a00000-0000-4000-8000-000000000021', 48)$$),
          '42501:', 'A01-5 客服(有營業時間權限)新增時改取消期限 ⇒ 保護 trigger 擋');
select pg_temp.as_user('c4a00000-0000-4000-8000-000000000001');
select lives_ok($$insert into merchant_booking_settings (merchant_id, customer_cancel_deadline_hours) values ('c4a00000-0000-4000-8000-000000000021', 48)$$,
          'A01-6 管理員可以設定取消期限');
select pg_temp.as_user('c4a00000-0000-4000-8000-000000000002');
select is(pg_temp.err($$update merchant_booking_settings set customer_cancel_deadline_hours = 0 where merchant_id = 'c4a00000-0000-4000-8000-000000000021'$$),
          '42501:', 'A01-7 客服修改取消期限 ⇒ 保護 trigger 擋');
select pg_temp.as_postgres();
update merchant_booking_settings set customer_cancel_deadline_hours = 24 where merchant_id = 'c4a00000-0000-4000-8000-000000000021';
select lives_ok($$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body) values
  ('c4a00000-0000-4000-8000-000000000001', 'c4a00000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), 'booking_created', 't', 'b'),
  ('c4a00000-0000-4000-8000-000000000001', 'c4a00000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), 'customer_booking_created', 't', 'b'),
  ('c4a00000-0000-4000-8000-000000000001', 'c4a00000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), 'customer_booking_cancelled', 't', 'b'),
  ('c4a00000-0000-4000-8000-000000000001', 'c4a00000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), 'member_contact_request', 't', 'b')$$,
  'A01-8 鈴鐺舊值與兩個新事件都可寫');
select is(pg_temp.err($$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body) values
  ('c4a00000-0000-4000-8000-000000000001', 'c4a00000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), 'hacker_event', 't', 'b')$$),
  '23514:', 'A01-9 鈴鐺亂值被拒');
select is(pg_temp.err(format($f$update members set address = %L where id = 'c4a00000-0000-4000-8000-000000000042'$f$, repeat('址', 201))),
          '23514:', 'A01-10 members.address 超過 200 字被 check 擋');

-- =========================================================================
-- A02 身分判斷(透過 customer_get_member_home 的 state)
-- =========================================================================
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
select is(public.customer_get_member_home('pgtap-c4m-shop') ->> 'state', 'ok', 'A02-1 linked ⇒ ok');
select is(public.customer_get_member_home('PGTAP-C4M-SHOP ') ->> 'state', 'ok', 'A02-2 代碼大小寫 / 空白不影響');
select is(public.customer_get_member_home('pgtap-c4m-off') ->> 'state', 'unavailable', 'A02-3 店家停用 ⇒ unavailable');
select is(public.customer_get_member_home('pgtap-c4m-nope') ->> 'state', 'unavailable', 'A02-4 代碼不存在 ⇒ unavailable');
select is(public.customer_get_member_home('pgtap-c4m-noline') ->> 'state', 'unavailable', 'A02-5 沒啟用 LINE 登入 ⇒ unavailable');
select is(public.customer_get_member_home('pgtap-c4m-other') ->> 'state', 'not_linked', 'A02-6 拿 A 店帳號打 B 店 ⇒ not_linked(F03)');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000013');
select is(public.customer_get_member_home('pgtap-c4m-shop') ->> 'state', 'not_linked', 'A02-7 別的 LINE channel ⇒ not_linked');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000014');
select is(public.customer_get_member_home('pgtap-c4m-shop') ->> 'state', 'not_linked', 'A02-8 還沒接上會員 ⇒ not_linked');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000017');
select is(public.customer_get_member_home('pgtap-c4m-shop') ->> 'state', 'not_linked', 'A02-9 會員已下架 ⇒ not_linked');
select pg_temp.as_user('c4a00000-0000-4000-8000-000000000001');
select is(public.customer_get_member_home('pgtap-c4m-shop') ->> 'state', 'not_linked', 'A02-10 後台帳號(不是客人帳號)⇒ not_linked');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000015');
select is(public.customer_get_member_home('pgtap-c4m-shop') ->> 'state', 'not_linked',
          'A02-11 JWT 宣稱客人但 auth.users 不是客人帳號 ⇒ not_linked');
select pg_temp.as_postgres();
select is((select row(c.state, c.member_id, c.contact_id, c.is_primary)::text from private.customer_me_context('pgtap-c4m-shop', 'c4a00000-0000-4000-8000-000000000011') c),
          row('ok', 'c4a00000-0000-4000-8000-000000000041'::uuid,
              (select id from member_customer_contacts where member_id = 'c4a00000-0000-4000-8000-000000000041' and status = 'active'), true)::text,
          'A02-12 customer_me_context 回會員 id;第 4-B 批起 contact_id = 聯絡人列、is_primary = true');
select is((select count(*)::integer from private.customer_member_of('c4a00000-0000-4000-8000-000000000021', null)), 0,
          'A02-13 customer_member_of(user null)⇒ 0 列');

-- =========================================================================
-- C01 首頁
-- =========================================================================
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
insert into c4m_out values ('home', public.customer_get_member_home('pgtap-c4m-shop'));
select pg_temp.as_postgres();
select is((select body -> 'next_booking' ->> 'id' from c4m_out where label = 'home'), (select id::text from c4m_b where k = 'b6'),
          'C01-1 next_booking = 即將到來最早一筆(2 小時後那張)');
select is((select (body ->> 'upcoming_count')::integer from c4m_out where label = 'home'), 4,
          'C01-2 upcoming_count = 4(b1、b2、b6、b7;不含已取消 / 已結束 / 別人的)');
select is((select body -> 'member' from c4m_out where label = 'home'),
          '{"name": "王小明", "is_primary": true, "missing": ["birthday", "email", "address"]}'::jsonb, 'C01-3 member + missing 固定順序');
select is((select body -> 'wallet' from c4m_out where label = 'home'),
          '{"points_enabled": true, "points_balance": 320, "stored_value": null}'::jsonb, 'C01-4 沒有紅利設定列 ⇒ 預設開啟 + 餘額');
select is((select (body ->> 'pending_contact_requests')::integer from c4m_out where label = 'home'), 0, 'C01-5 4-A 申請數固定 0');
select is((select array_agg(k order by k) from c4m_out, jsonb_object_keys(body) k where label = 'home'),
          array['line_notify', 'member', 'next_booking', 'pending_contact_requests', 'state', 'upcoming_count', 'wallet'], 'C01-6 最上層 key 白名單(第 5 批加 line_notify)');
insert into merchant_member_settings (merchant_id, points_feature_enabled) values ('c4a00000-0000-4000-8000-000000000021', false);
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
select is(public.customer_get_member_home('pgtap-c4m-shop') -> 'wallet',
          '{"points_enabled": false, "points_balance": null, "stored_value": null}'::jsonb, 'C01-7 紅利關閉 ⇒ 不回餘額');
select pg_temp.as_postgres();
delete from merchant_member_settings where merchant_id = 'c4a00000-0000-4000-8000-000000000021';
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000012');
select is(public.customer_get_member_home('pgtap-c4m-shop') -> 'next_booking' ->> 'id', (select id::text from c4m_b where k = 'o1'),
          'C01-8 別的會員只看到自己的單');

-- =========================================================================
-- A03 BookingView
-- =========================================================================
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
insert into c4m_out values ('up', public.customer_list_my_bookings('pgtap-c4m-shop', 'upcoming'));
select pg_temp.as_postgres();
select is((select array_agg(k order by k) from c4m_out, jsonb_object_keys(body -> 'items' -> 0) k where label = 'up'),
          array['address', 'amount', 'booked_by', 'booked_online', 'can_cancel', 'cancel_deadline_at', 'cancelled_at', 'customer_name',
                'customer_notes', 'end_at', 'id', 'items', 'points_redeemed', 'staff_display', 'start_at', 'status'],
          'A03-1 BookingView key 白名單(16 個)');
select is((select e - 'start_at' - 'end_at' - 'cancel_deadline_at' from c4m_out, jsonb_array_elements(body -> 'items') e
           where label = 'up' and e ->> 'id' = (select id::text from c4m_b where k = 'b1')),
          jsonb_build_object('id', (select id from c4m_b where k = 'b1'), 'status', 'accepted', 'staff_display', '阿明',
            'items', '[{"name": "室內機清洗", "quantity": 2}, {"name": "加購除臭", "quantity": 1}]'::jsonb,
            'address', '台北市測試路 1 號', 'customer_name', '王小明', 'customer_notes', '客人備註', 'amount', 2200,
            'points_redeemed', 0, 'booked_online', false, 'booked_by', null, 'can_cancel', true, 'cancelled_at', null),
          'A03-2 b1:暱稱、主要項目在前、停用項目照樣顯示、後台單 booked_online = false、可以取消');
select is((select (e ->> 'cancel_deadline_at')::timestamptz from c4m_out, jsonb_array_elements(body -> 'items') e
           where label = 'up' and e ->> 'id' = (select id::text from c4m_b where k = 'b1')),
          (select start_at - interval '24 hours' from bookings where id = (select id from c4m_b where k = 'b1')),
          'A03-3 cancel_deadline_at = 開始時間 − 24 小時(沒設定列)');
select is((select row(e ->> 'staff_display', e ->> 'can_cancel')::text from c4m_out, jsonb_array_elements(body -> 'items') e
           where label = 'up' and e ->> 'id' = (select id::text from c4m_b where k = 'b6')),
          row('本名小陳', 'false')::text, 'A03-4 沒暱稱用本名;2 小時後的單已過期限 ⇒ can_cancel = false');
select is((select e ->> 'status' from c4m_out, jsonb_array_elements(body -> 'items') e
           where label = 'up' and e ->> 'id' = (select id::text from c4m_b where k = 'b7')),
          'pending_confirmation', 'A03-5 pending_reply ⇒ 客人看到 pending_confirmation');
select is((select e ->> 'booked_online' from c4m_out, jsonb_array_elements(body -> 'items') e
           where label = 'up' and e ->> 'id' = (select id::text from c4m_b where k = 'b2')),
          'true', 'A03-6 客人線上送出的單 booked_online = true');
select is((select (e ->> 'can_cancel') from c4m_out, jsonb_array_elements(body -> 'items') e
           where label = 'up' and e ->> 'id' = (select id::text from c4m_b where k = 'b7')),
          'false', 'A03-7 pending_reply 不能取消(跟後台 cancel_booking 一樣只收待確認 / 已確認)');

-- =========================================================================
-- C03 我的預約
-- =========================================================================
select is((select jsonb_agg(e ->> 'id') from c4m_out, jsonb_array_elements(body -> 'items') e where label = 'up'),
          (select jsonb_agg(id::text order by ord) from (select id, case k when 'b6' then 1 when 'b1' then 2 when 'b2' then 3 when 'b7' then 4 end ord
                                                          from c4m_b where k in ('b1', 'b2', 'b6', 'b7')) x),
          'C03-1 upcoming:b6 → b1 → b2 → b7(由近到遠;不含已取消 b4、已結束 b5、別人的 o1)');
select is((select body -> 'counts' from c4m_out where label = 'up'), '{"upcoming": 4, "history": 24}'::jsonb,
          'C03-2 counts(歷史 = b3、b4、b5 + 21 張)');
select is((select body -> 'next_cursor' from c4m_out where label = 'up'), 'null'::jsonb, 'C03-3 只有一頁 ⇒ next_cursor null');

-- 歷史分頁:每頁 5 筆走到底,串起來 = 全部 24 筆、不重複、由新到舊
create temp table c4m_pages (page integer, ids jsonb, next_cursor text);
grant all on c4m_pages to authenticated;
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
do $$
declare v jsonb; v_cursor timestamptz := null; v_page integer := 0;
begin
  loop
    v_page := v_page + 1;
    v := public.customer_list_my_bookings('pgtap-c4m-shop', 'history', v_cursor, 5);
    insert into c4m_pages values (v_page, (select coalesce(jsonb_agg(e ->> 'id'), '[]'::jsonb) from jsonb_array_elements(v -> 'items') e), v ->> 'next_cursor');
    exit when v -> 'next_cursor' = 'null'::jsonb or v_page > 20;
    v_cursor := (v ->> 'next_cursor')::timestamptz;
  end loop;
end $$;
select pg_temp.as_postgres();
select is((select count(*)::integer from c4m_pages, jsonb_array_elements_text(ids)), 24, 'C03-4 分頁走完總筆數 = 24');
select is((select count(distinct x)::integer from c4m_pages, jsonb_array_elements_text(ids) x), 24, 'C03-5 分頁不重複');
select is((select array_agg(x::uuid order by p.page, o) from c4m_pages p, jsonb_array_elements_text(p.ids) with ordinality t(x, o)),
          (select array_agg(b.id order by b.start_at desc, b.id desc) from bookings b
           where b.member_id = 'c4a00000-0000-4000-8000-000000000041' and (b.status in ('completed', 'cancelled') or b.end_at < now())),
          'C03-6 串起來 = 由新到舊、同時間依 id');
select ok((select bool_and(jsonb_array_length(ids) >= 5 or next_cursor is null) from c4m_pages),
          'C03-7 除了最後一頁,每頁至少 5 筆(同一個開始時間不切開時可能多 1 筆)');
select ok(exists (select 1 from c4m_pages p where p.ids ? (select id::text from c4m_b where k = 'h05')
                                             and p.ids ? (select id::text from c4m_b where k = 'h05b')),
          'C03-8 同一個開始時間的兩張落在同一頁');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
select is(pg_temp.err($$select public.customer_list_my_bookings('pgtap-c4m-shop', 'all')$$), '22023:invalid_scope', 'C03-9 範圍亂填 ⇒ invalid_scope');
select is(pg_temp.err($$select public.customer_list_my_bookings('pgtap-c4m-shop', null)$$), '22023:invalid_scope', 'C03-10 範圍 null ⇒ invalid_scope');
select is(jsonb_array_length(public.customer_list_my_bookings('pgtap-c4m-shop', 'history', null, 999) -> 'items'), 24,
          'C03-11 p_limit 超過 50 被夾成 50(24 筆一次全回)');
select is(jsonb_array_length(public.customer_list_my_bookings('pgtap-c4m-shop', 'upcoming', null, 1) -> 'items'), 1, 'C03-12 upcoming 也能分頁');
insert into c4m_out values ('up1', public.customer_list_my_bookings('pgtap-c4m-shop', 'upcoming', null, 1));
select is(public.customer_list_my_bookings('pgtap-c4m-other', 'upcoming') ->> 'state', 'not_linked', 'C03-14 打別家店 ⇒ not_linked');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000012');
select is((select jsonb_agg(e ->> 'id') from jsonb_array_elements(public.customer_list_my_bookings('pgtap-c4m-shop', 'upcoming') -> 'items') e),
          jsonb_build_array((select id::text from c4m_b where k = 'o1')), 'C03-15 別的會員看不到王小明的單(F03)');
select pg_temp.as_postgres();
select is((select (body ->> 'next_cursor')::timestamptz from c4m_out where label = 'up1'),
          (select start_at from bookings where id = (select id from c4m_b where k = 'b6')), 'C03-13 upcoming 下一頁游標 = 這頁最後一筆開始時間');

-- =========================================================================
-- E01 我的資料 / E05 session state / K02 公開頁
-- =========================================================================
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
insert into c4m_out values ('profile', public.customer_get_profile('pgtap-c4m-shop'));
select pg_temp.as_postgres();
select is((select body from c4m_out where label = 'profile'),
          '{"state": "ok", "member": {"name": "王小明", "phone": "0912400041", "birthday": null, "address": null, "email": null},
            "me": {"line_display_name": "LINE小明", "line_picture_url": "https://example.com/p11.png", "is_primary": true, "contact_phone": null},
            "can_edit": true}'::jsonb, 'E01-1 我的資料完整回傳(白名單)');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000014');
select is(public.customer_get_profile('pgtap-c4m-shop') ->> 'state', 'not_linked', 'E01-2 沒接上 ⇒ not_linked');

-- =========================================================================
-- E03 修改我的資料
-- =========================================================================
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4m-shop', '   ', null, null, null)$$), '22023:invalid_name', 'E03-1 姓名空白');
select is(pg_temp.err(format($f$select public.customer_update_profile('pgtap-c4m-shop', %L, null, null, null)$f$, repeat('名', 51))), '22023:invalid_name', 'E03-2 姓名 51 字');
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4m-shop', '王小明', null, null, 'not-an-email')$$), '22023:invalid_email', 'E03-3 Email 格式');
select is(pg_temp.err(format($f$select public.customer_update_profile('pgtap-c4m-shop', '王小明', null, null, %L)$f$, repeat('a', 250) || '@x.tw')), '22023:invalid_email', 'E03-4 Email 超過 254');
select is(pg_temp.err(format($f$select public.customer_update_profile('pgtap-c4m-shop', '王小明', null, %L, null)$f$, repeat('址', 201))), '22023:invalid_address', 'E03-5 地址 201 字');
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4m-shop', '王小明', (now() at time zone 'Asia/Taipei')::date + 1, null, null)$$), '22023:invalid_birthday', 'E03-6 生日是未來');
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4m-shop', '王小明', '1899-12-31', null, null)$$), '22023:invalid_birthday', 'E03-7 生日早於 1900');
select pg_temp.as_postgres();
create temp table c4m_before as select * from members where id = 'c4a00000-0000-4000-8000-000000000041';
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
select is(public.customer_update_profile('pgtap-c4m-shop', E'  王\n大明　', '1990-05-01', '  新北市 2 號 ', ' ming@example.com '),
          '{"state": "ok", "member": {"name": "王 大明", "phone": "0912400041", "birthday": "1990-05-01", "address": "新北市 2 號", "email": "ming@example.com"}}'::jsonb,
          'E03-8 成功:姓名換行換空白、去頭尾(含全形)空白;地址 / Email 去空白');
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4m-shop', '王大明', '1991-01-01', null, null)$$), '22023:birthday_locked', 'E03-9 已有生日改別天 ⇒ birthday_locked');
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4m-shop', '王大明', null, null, null)$$), '22023:birthday_locked', 'E03-10 已有生日送 null ⇒ birthday_locked');
select is(public.customer_update_profile('pgtap-c4m-shop', '王大明', '1990-05-01', '', '') -> 'member',
          '{"name": "王大明", "phone": "0912400041", "birthday": "1990-05-01", "address": null, "email": null}'::jsonb,
          'E03-11 生日原樣送回可以;空字串 = 清掉地址 / Email');
select pg_temp.as_postgres();
select is((select row(m.phone, m.notes, m.points_balance, m.user_id, m.line_user_id, m.is_blacklisted, m.blacklist_reason, m.tier_id, m.status, m.referral_code)::text
           from members m where m.id = 'c4a00000-0000-4000-8000-000000000041'),
          (select row(b.phone, b.notes, b.points_balance, b.user_id, b.line_user_id, b.is_blacklisted, b.blacklist_reason, b.tier_id, b.status, b.referral_code)::text from c4m_before b),
          'E03-12 members 其他欄位前後一致');
select is((select count(*)::integer from bookings where member_id = 'c4a00000-0000-4000-8000-000000000041' and customer_name = '王小明'),
          (select count(*)::integer from bookings where member_id = 'c4a00000-0000-4000-8000-000000000041'), 'E03-13 既有訂單上的姓名不動');
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000014');
select is(public.customer_update_profile('pgtap-c4m-shop', '駭客', null, null, null) ->> 'state', 'not_linked', 'E03-14 沒接上 ⇒ not_linked,不改任何資料');
select pg_temp.as_postgres();
select is((select name from members where id = 'c4a00000-0000-4000-8000-000000000041'), '王大明', 'E03-15 確認 E03-14 沒改到別人');

-- E05
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000012');
select is(public.get_customer_session_state('pgtap-c4m-shop') -> 'member',
          '{"name": "C4_OTHER_MEMBER_SENTINEL", "phone": "0912400042", "address": null}'::jsonb, 'E05-1 linked 多回 address');
select pg_temp.as_postgres();
update members set address = '台中市 3 號' where id = 'c4a00000-0000-4000-8000-000000000042';
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000012');
select is(public.get_customer_session_state('pgtap-c4m-shop') -> 'member' ->> 'address', '台中市 3 號', 'E05-2 有地址 ⇒ 回地址');
select pg_temp.as_postgres();

-- K02
select is(public.get_public_booking_page('pgtap-c4m-shop') -> 'booking_settings' -> 'customer_cancel_deadline_hours', '24'::jsonb,
          'K02-1 公開頁回取消期限(設定 24)');
select is(public.get_public_booking_page('pgtap-c4m-other') -> 'booking_settings' -> 'customer_cancel_deadline_hours', '24'::jsonb,
          'K02-2 沒有設定列 ⇒ 24');
update merchant_booking_settings set customer_cancel_deadline_hours = 0 where merchant_id = 'c4a00000-0000-4000-8000-000000000022';
select is(public.get_public_booking_page('pgtap-c4m-noline') -> 'booking_settings' -> 'customer_cancel_deadline_hours', '0'::jsonb,
          'K02-3 設 0 ⇒ 回 0');

-- =========================================================================
-- A04 後台改地址(update_member)
-- =========================================================================
select pg_temp.as_user('c4a00000-0000-4000-8000-000000000001');
select is((public.update_member('c4a00000-0000-4000-8000-000000000042', 'C4_OTHER_MEMBER_SENTINEL', '0912400042', null, null, null, null)).address,
          '台中市 3 號', 'A04-1 舊的 7 參數呼叫(匯入 / 復原)⇒ 地址不變');
select is((public.update_member('c4a00000-0000-4000-8000-000000000042', 'C4_OTHER_MEMBER_SENTINEL', '0912400042', null, null, null, null, '  高雄市 4 號 ')).address,
          '高雄市 4 號', 'A04-2 帶地址 ⇒ 去空白存入');
select is((public.update_member('c4a00000-0000-4000-8000-000000000042', 'C4_OTHER_MEMBER_SENTINEL', '0912400042', null, null, null, null, '   ')).address,
          null, 'A04-3 只有空白 ⇒ 清掉');
select is(pg_temp.err(format($f$select public.update_member('c4a00000-0000-4000-8000-000000000042', 'x', '0912400042', null, null, null, null, %L)$f$, repeat('址', 201))),
          '22023:invalid_address', 'A04-4 超過 200 字 ⇒ invalid_address');
select (public.update_member('c4a00000-0000-4000-8000-000000000042', 'C4_OTHER_MEMBER_SENTINEL', '0912400042', 'other@example.com', '1990-01-01', null, null, '屏東市 5 號')).id;
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000012');
select is(public.customer_get_profile('pgtap-c4m-shop') -> 'member' ->> 'address', '屏東市 5 號', 'A04-5 後台改地址 ⇒ 客人我的資料看到同一個值');
select pg_temp.as_user('c4a00000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select public.update_member('c4a00000-0000-4000-8000-000000000042', 'x', '0912400042', null, null, null, null, 'x')$$),
          'ok', 'A04-6 有會員權限的客服也能改(權限沿用 can_manage_members)');
select pg_temp.as_postgres();

-- =========================================================================
-- F02 哨兵(王小明的首頁 / 我的預約兩頁 / 我的資料)
-- =========================================================================
select pg_temp.as_customer('c4a00000-0000-4000-8000-000000000011');
insert into c4m_out values ('hist', public.customer_list_my_bookings('pgtap-c4m-shop', 'history', null, 50));
insert into c4m_out values ('profile2', public.customer_get_profile('pgtap-c4m-shop'));
select pg_temp.as_postgres();
select is((select count(*)::integer from c4m_out
           where body::text ~ 'C4_INTERNAL_NOTES_SENTINEL|C4_STAFF_REALNAME_SENTINEL|0900999031|0900999032|C4_MEMBER_NOTES_SENTINEL|C4_BLACKLIST_REASON_SENTINEL|C4_LINE_UID_SENTINEL|C4REF|c4a00000-0000-4000-8000-00000000003|c4a00000-0000-4000-8000-000000000041'
             and label in ('home', 'up', 'hist', 'profile', 'profile2')), 0,
          'F02-1 首頁 / 我的預約 / 我的資料搜不到內部備註、服務人員本名 / 電話 / id、會員 notes、黑名單原因、LINE userId、推薦碼、member_id');
select is((select count(*)::integer from c4m_out where body::text like '%C4_OTHER_MEMBER_SENTINEL%' and label in ('home', 'up', 'hist', 'profile', 'profile2')), 0,
          'F02-2 王小明的回應裡沒有其他會員姓名');
select is((select count(*)::integer from c4m_out where body::text like '%0912400041%' and label in ('home', 'up', 'hist')), 0,
          'F02-3 BookingView 不回客人電話');
select is((select count(*)::integer from c4m_out, jsonb_array_elements(body -> 'items') e where label = 'hist' and e ? 'member_id'), 0,
          'F02-4 BookingView 沒有 member_id');

select * from finish();
rollback;
