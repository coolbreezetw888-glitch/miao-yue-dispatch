-- 客戶端第 4-B 批 — 多位聯絡人(#1041):C4-H01~H11、K03、K04、F01~F04
-- 規格書 .project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」優先:Q2 = A、Q6)
--
--   H01  四張表 RLS 開、沒有 policy、anon / authenticated 沒有表權限;每位會員只能一位主要;同店同帳號只能一位會員
--   H02  第一個人 = 主要聯絡人(新建會員 / 接上沒有聯絡人的既有會員);members.user_id / line_user_id 同步
--   H03  邀請:建立(只存雜湊、32 碼)、上限 5、撤銷、非主要不能建、IDOR
--   H04  同電話 ⇒ 申請(join_pending、回應只有 state、鈴鐺、冪等、取消、上限 5、封鎖仍 phone_taken)
--   H05  處理申請:拒絕 / 同意 / 過期 / 後台版權限
--   H06  peek(valid / invalid / unavailable、不回會員姓名)、保留(claim)
--   H07  接受邀請每個分支
--   H08  第二聯絡人電話
--   H09  聯絡人清單視角(主要 / 第二)
--   H10  移除(封鎖)、退出、轉移主要、booked_by
--   H11  session state(linked / join_pending / needs_profile.join_request)、unbind 清掉全部聯絡人
--   K03  create_member / update_member / create_booking 擋聯絡人電話;get_members_by_phone、search、resolve_guest_member 找得到
--   K04  後台清單 / 指定主要 / 移除(need_new_primary)
--   F01  proacl;F02 哨兵;F03 IDOR
begin;

select plan(187);

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
create function pg_temp.errmsg(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
grant execute on function pg_temp.errmsg(text) to anon, authenticated, service_role;

create temp table o (label text primary key, body jsonb);
grant all on o to anon, authenticated, service_role;
create function pg_temp.c(p_label text) returns uuid language sql as $$ select (body ->> 'id')::uuid from o where label = p_label $$;
grant execute on function pg_temp.c(text) to anon, authenticated, service_role;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c4b00000-0000-4000-8000-000000000001', 'pgtap-c4b-admin@test.local', '{}'::jsonb),
  ('c4b00000-0000-4000-8000-000000000002', 'pgtap-c4b-agent-m@test.local', '{}'::jsonb),
  ('c4b00000-0000-4000-8000-000000000003', 'pgtap-c4b-agent-o@test.local', '{}'::jsonb);
insert into auth.users (id, email, raw_app_meta_data)
select ('c4b00000-0000-4000-8000-0000000000' || s)::uuid, 'line-pgtap-c4b-' || s || '@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb
from unnest(array['11','12','13','14','15','16','17','18','19','21','22','23','24','25','26']) s;

insert into groups (id) values ('c4b00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000091', 'C4B聯絡人店', 'in_store_beauty', 'pgtap-c4b-m', 'active'),
  ('c4b00000-0000-4000-8000-000000000032', 'c4b00000-0000-4000-8000-000000000091', 'C4B沒LINE店', 'in_store_beauty', 'pgtap-c4b-noline', 'active');
insert into merchant_admins (merchant_id, user_id) values
  ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c4b00000-0000-4000-8000-000000000071', 'c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000002', 'C4B會員客服', '0900500071', 'pgtap-c4b-agent-m@test.local', 'active'),
  ('c4b00000-0000-4000-8000-000000000072', 'c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000003', 'C4B訂單客服', '0900500072', 'pgtap-c4b-agent-o@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c4b00000-0000-4000-8000-000000000071', 'members', true),
  ('c4b00000-0000-4000-8000-000000000072', 'orders', true);
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c4b00000-0000-4000-8000-000000000031', '5151515151', vault.create_secret('C4BFAKESECRET00000000000000000AA'), '00AA', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name, picture_url)
select ('c4b00000-0000-4000-8000-0000000000' || s)::uuid, '5151515151', 'U-C4B-LINESUB-SENTINEL-' || s, 'LINE' || s, null
from unnest(array['11','12','13','14','15','16','17','18','19','21','22','23','24','25','26']) s;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c4b00000-0000-4000-8000-000000000061', 'c4b00000-0000-4000-8000-000000000031', '洗髮', 500, 'primary', 30);
insert into payment_methods (id, merchant_id, name) values
  ('c4b00000-0000-4000-8000-000000000062', 'c4b00000-0000-4000-8000-000000000031', '現金');
insert into merchant_staff (id, merchant_id, name, status, login_status, phone) values
  ('c4b00000-0000-4000-8000-000000000051', 'c4b00000-0000-4000-8000-000000000031', '服務人員甲', 'active', 'not_invited', '0900500051');
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'c4b00000-0000-4000-8000-000000000051', d::smallint, '00:00', '24:00' from generate_series(0, 6) d;
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'c4b00000-0000-4000-8000-000000000031', d, false, '00:00', '23:59' from generate_series(0, 6) d;

-- M1 王公司(沒有聯絡人);M2 別的會員(主要 = 14,直接寫 + 聯絡人列);M3 空會員
insert into members (id, merchant_id, name, phone, referral_code) values
  ('c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000031', '王公司', '0912500001', 'C4BREF41'),
  ('c4b00000-0000-4000-8000-000000000043', 'c4b00000-0000-4000-8000-000000000031', '空會員', '0912500003', 'C4BREF43');
insert into members (id, merchant_id, name, phone, referral_code, user_id, notes) values
  ('c4b00000-0000-4000-8000-000000000042', 'c4b00000-0000-4000-8000-000000000031', 'C4B_OTHER_MEMBER_SENTINEL', '0912500002', 'C4BREF42',
   'c4b00000-0000-4000-8000-000000000014', 'C4B_MEMBER_NOTES_SENTINEL');
insert into member_customer_contacts (merchant_id, member_id, user_id, is_primary, joined_via)
values ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000042', 'c4b00000-0000-4000-8000-000000000014', true, 'backfill');

-- =========================================================================
-- H01 資料表
-- =========================================================================
select is((select array_agg(c.relname::text order by c.relname) from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
             and c.relname in ('member_customer_contacts', 'member_contact_invites', 'member_contact_invite_claims', 'member_contact_requests')),
          array['member_contact_invite_claims', 'member_contact_invites', 'member_contact_requests', 'member_customer_contacts'],
          'H01-1 四張表都開 RLS');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
           where c.relname in ('member_customer_contacts', 'member_contact_invites', 'member_contact_invite_claims', 'member_contact_requests')),
          0, 'H01-2 沒有任何 policy');
select is((select count(*)::int from information_schema.role_table_grants
           where table_schema = 'public' and grantee in ('anon', 'authenticated')
             and table_name in ('member_customer_contacts', 'member_contact_invites', 'member_contact_invite_claims', 'member_contact_requests')),
          0, 'H01-3 anon / authenticated 沒有任何表權限');
select throws_ok($$insert into member_customer_contacts (merchant_id, member_id, user_id, is_primary, joined_via)
                   values ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000042', 'c4b00000-0000-4000-8000-000000000026', true, 'store')$$,
                 '23505', null, 'H01-4 同一位會員不能有第二位 active 主要聯絡人');
select throws_ok($$insert into member_customer_contacts (merchant_id, member_id, user_id, is_primary, joined_via)
                   values ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000043', 'c4b00000-0000-4000-8000-000000000014', true, 'store')$$,
                 '23505', null, 'H01-5 同一個帳號在同一間店只能是一位會員的 active 聯絡人');
select is((select count(*)::int from members m
           where m.user_id is not null
             and not exists (select 1 from member_customer_contacts c
                             where c.member_id = m.id and c.user_id = m.user_id and c.is_primary and c.status = 'active')),
          0, 'H01-6 回填不變式:每位 members.user_id 不為 null 的會員都有對應的 active 主要聯絡人');

-- =========================================================================
-- H02 第一個人 = 主要聯絡人
-- =========================================================================
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
insert into o values ('h02_link', public.customer_complete_profile('pgtap-c4b-m', '0912-500-001', '我', true));
select pg_temp.as_postgres();
select is((select body from o where label = 'h02_link'), '{"state": "linked", "existing": true}'::jsonb, 'H02-1 接上沒有聯絡人的既有會員 ⇒ linked existing');
select is((select is_primary::text || '/' || joined_via || '/' || status from member_customer_contacts
           where member_id = 'c4b00000-0000-4000-8000-000000000041' and user_id = 'c4b00000-0000-4000-8000-000000000011'),
          'true/first_login/active', 'H02-2 成為主要聯絡人(first_login)');
select is((select user_id::text || '/' || line_user_id || '/' || line_bound from members where id = 'c4b00000-0000-4000-8000-000000000041'),
          'c4b00000-0000-4000-8000-000000000011/U-C4B-LINESUB-SENTINEL-11/true', 'H02-3 members.user_id / line_user_id / line_bound 同步主要聯絡人');
select is((select count(*)::int from user_notifications where merchant_id = 'c4b00000-0000-4000-8000-000000000031' and event_type = 'member_line_login_linked'),
          2, 'H02-4 接上鈴鐺照舊(管理員 + 會員客服)');

select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000015');
insert into o values ('h02_new', public.customer_complete_profile('pgtap-c4b-m', '0912500099', '新客人', true));
select pg_temp.as_postgres();
select is((select body from o where label = 'h02_new'), '{"state": "linked", "created": true}'::jsonb, 'H02-5 新電話 ⇒ 建會員');
select is((select c.is_primary::text || '/' || c.joined_via || '/' || (m.user_id = c.user_id)::text
           from member_customer_contacts c join members m on m.id = c.member_id
           where c.user_id = 'c4b00000-0000-4000-8000-000000000015' and c.status = 'active'),
          'true/first_login/true', 'H02-6 新會員的建立者 = 主要聯絡人');

-- session state(H11)
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(public.get_customer_session_state('pgtap-c4b-m') - 'line_picture_url',
          '{"state": "linked", "line_display_name": "LINE11", "is_primary": true, "member": {"name": "王公司", "phone": "0912500001", "address": null}}'::jsonb,
          'H11-1 linked 多 is_primary');

-- =========================================================================
-- H03 邀請
-- =========================================================================
insert into o values ('inv1', public.customer_create_contact_invite('pgtap-c4b-m'));
select pg_temp.as_postgres();
select ok((select body ->> 'path' ~ '^/booking/pgtap-c4b-m/invite/[A-Za-z0-9_-]{32}$' from o where label = 'inv1'), 'H03-1 回 path,邀請碼 32 碼 base64url');
select is((select body ->> 'state' from o where label = 'inv1'), 'ok', 'H03-2 state ok');
select is((select extract(epoch from expires_at - created_at)::int::text from member_contact_invites where id = ((select body -> 'invite' ->> 'id' from o where label = 'inv1'))::uuid),
          '259200', 'H03-3 72 小時');
select is((select token_hash from member_contact_invites where id = ((select body -> 'invite' ->> 'id' from o where label = 'inv1'))::uuid),
          (select encode(sha256(convert_to(split_part(body ->> 'path', '/', 5), 'UTF8')), 'hex') from o where label = 'inv1'),
          'H03-4 資料庫只存 SHA-256');
select is((select count(*)::int from member_contact_invites i, o
           where o.label = 'inv1' and to_jsonb(i)::text like '%' || split_part(o.body ->> 'path', '/', 5) || '%'),
          0, 'H03-5 邀請碼原文不在資料表任何欄位');

create temp table tok (k text primary key, t text);
grant all on tok to anon, authenticated, service_role;
insert into tok select 'inv1', split_part(body ->> 'path', '/', 5) from o where label = 'inv1';

select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
insert into tok select 'inv' || i, split_part(public.customer_create_contact_invite('pgtap-c4b-m') ->> 'path', '/', 5) from generate_series(2, 5) i;
select is(public.customer_create_contact_invite('pgtap-c4b-m'), '{"state": "invite_limit"}'::jsonb, 'H03-6 有效邀請最多 5 個');
select pg_temp.as_postgres();
insert into o select 'inv5_id', jsonb_build_object('id', id) from member_contact_invites
  where token_hash = encode(sha256(convert_to((select t from tok where k = 'inv5'), 'UTF8')), 'hex');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(public.customer_revoke_contact_invite('pgtap-c4b-m', pg_temp.c('inv5_id')), '{"state": "ok"}'::jsonb, 'H03-7 撤銷');
select is(public.customer_revoke_contact_invite('pgtap-c4b-m', pg_temp.c('inv5_id')), '{"state": "not_found"}'::jsonb, 'H03-8 撤銷過的再撤銷 ⇒ not_found');
select is(public.customer_create_contact_invite('pgtap-c4b-m') ->> 'state', 'ok', 'H03-9 撤銷後可以再建');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000014');
select is(public.customer_revoke_contact_invite('pgtap-c4b-m', (select (body -> 'invite' ->> 'id')::uuid from o where label = 'inv1')),
          '{"state": "not_found"}'::jsonb, 'F03-1 別的會員的主要聯絡人撤銷不了這張邀請(not_found)');

-- =========================================================================
-- H06 peek
-- =========================================================================
select pg_temp.as_anon();
select is(public.customer_peek_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv1')),
          '{"state": "valid", "merchant_name": "C4B聯絡人店"}'::jsonb, 'H06-1 anon 可以 peek;有效 ⇒ valid + 店名(不回會員姓名)');
select is(public.customer_peek_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv5')),
          '{"state": "invalid", "merchant_name": "C4B聯絡人店"}'::jsonb, 'H06-2 撤銷 ⇒ invalid');
select is(public.customer_peek_contact_invite('pgtap-c4b-m', 'x'), '{"state": "invalid", "merchant_name": "C4B聯絡人店"}'::jsonb, 'H06-3 格式不對 ⇒ invalid');
select is(public.customer_peek_contact_invite('pgtap-c4b-m', repeat('A', 32)), '{"state": "invalid", "merchant_name": "C4B聯絡人店"}'::jsonb, 'H06-4 不存在 ⇒ invalid');
select is(public.customer_peek_contact_invite('pgtap-c4b-noline', (select t from tok where k = 'inv1')), '{"state": "unavailable"}'::jsonb, 'H06-5 沒啟用 LINE 登入的店 ⇒ unavailable');
select is(public.customer_peek_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv1'))::text ~ '王公司', false, 'H06-6 peek 回應搜不到會員姓名');

-- =========================================================================
-- H07 接受邀請
-- =========================================================================
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv1'), null, true)$$),
          '42501:not_customer', 'H07-1 後台帳號 ⇒ 42501 not_customer');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000012');
select is(pg_temp.err($$select public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv1'), null, false)$$),
          '22023:policy_not_agreed', 'H07-2 沒勾同意');
select is(pg_temp.err($$select public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv1'), '12345', true)$$),
          '22023:invalid_phone', 'H07-3 電話格式錯');
insert into o values ('h07_s', public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv1'), '0987-500-012', true));
select is((select body from o where label = 'h07_s'), '{"state": "linked", "phone_result": "saved"}'::jsonb, 'H07-4 接受成功 ⇒ linked + saved');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv2'), null, true),
          '{"state": "linked", "phone_result": "none"}'::jsonb, 'H07-5 已經是這位會員的聯絡人 ⇒ linked(邀請不消耗)');
select pg_temp.as_postgres();
select is((select is_primary::text || '/' || joined_via || '/' || coalesce(contact_phone, '-') from member_customer_contacts
           where user_id = 'c4b00000-0000-4000-8000-000000000012' and status = 'active'),
          'false/invite/0987500012', 'H07-6 第二聯絡人、invite、電話存正規化');
select is((select (used_at is not null)::text || '/' || used_by_user_id::text from member_contact_invites
           where token_hash = encode(sha256(convert_to((select t from tok where k = 'inv1'), 'UTF8')), 'hex')),
          'true/c4b00000-0000-4000-8000-000000000012', 'H07-7 邀請標用過');
select is((select used_at from member_contact_invites
           where token_hash = encode(sha256(convert_to((select t from tok where k = 'inv2'), 'UTF8')), 'hex')),
          null, 'H07-8 已經是聯絡人時邀請不消耗');
select is((select count(*)::int from user_notifications where user_id = 'c4b00000-0000-4000-8000-000000000001' and event_type = 'member_line_login_linked'
           and title = '會員新增了聯絡人' and body = 'LINE12已加入成為會員「王公司」的聯絡人。'),
          1, 'H07-9 店家鈴鐺文字');
select is((select count(*)::int from customer_policy_consents where user_id = 'c4b00000-0000-4000-8000-000000000012' and member_id = 'c4b00000-0000-4000-8000-000000000041'),
          1, 'H07-10 寫同意紀錄');
select is((select user_id from members where id = 'c4b00000-0000-4000-8000-000000000041'), 'c4b00000-0000-4000-8000-000000000011'::uuid,
          'H07-11 members.user_id 仍是主要聯絡人');

select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000016');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv1'), null, true),
          '{"state": "invalid"}'::jsonb, 'H07-12 用過的邀請 ⇒ invalid');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000014');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv2'), null, true),
          '{"state": "already_member_elsewhere"}'::jsonb, 'H07-13 已經是別的會員的聯絡人');
select pg_temp.as_postgres();
update member_contact_invites set expires_at = now() - interval '1 second', created_at = now() - interval '73 hours'
 where token_hash = encode(sha256(convert_to((select t from tok where k = 'inv3'), 'UTF8')), 'hex');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000016');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv3'), null, true),
          '{"state": "invalid"}'::jsonb, 'H07-14 過期 ⇒ invalid');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', null, null, true), '{"state": "invalid"}'::jsonb, 'H07-15 p_token null 又沒有保留 ⇒ invalid');

-- 保留(LINE 登入回來)
set local role service_role;
select is(public.internal_customer_contact_invite_claim('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000016',
          encode(sha256(convert_to((select t from tok where k = 'inv2'), 'UTF8')), 'hex')), '{"state": "valid"}'::jsonb, 'H06-7 保留有效邀請');
select is(public.internal_customer_contact_invite_claim('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000017',
          encode(sha256(convert_to((select t from tok where k = 'inv3'), 'UTF8')), 'hex')), '{"state": "invalid"}'::jsonb, 'H06-8 過期邀請不能保留');
select is(public.internal_customer_contact_invite_claim('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000001',
          encode(sha256(convert_to((select t from tok where k = 'inv2'), 'UTF8')), 'hex')), '{"state": "invalid"}'::jsonb, 'H06-9 不是客人帳號不能保留');
select pg_temp.as_postgres();
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000016');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', null, '0912500002', true),
          '{"state": "linked", "phone_result": "in_use"}'::jsonb, 'H07-16 用保留的邀請加入;電話是別的會員的 ⇒ in_use(照樣加入)');
select pg_temp.as_postgres();
select is((select contact_phone from member_customer_contacts where user_id = 'c4b00000-0000-4000-8000-000000000016' and status = 'active'),
          null, 'H07-17 in_use 不存電話');
select is((select count(*)::int from member_contact_invite_claims where user_id = 'c4b00000-0000-4000-8000-000000000016'), 0, 'H07-18 保留列用完刪掉');

-- 同一位會員電話
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
insert into tok select 'inv6', split_part(public.customer_create_contact_invite('pgtap-c4b-m') ->> 'path', '/', 5);
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000017');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv6'), '0912500001', true),
          '{"state": "linked", "phone_result": "same_as_member"}'::jsonb, 'H07-19 電話跟會員電話一樣 ⇒ same_as_member');

-- =========================================================================
-- H09 聯絡人清單 / 首頁 / 我的資料視角
-- =========================================================================
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
insert into o values ('list_p', public.customer_list_contacts('pgtap-c4b-m'));
insert into o values ('home_p', public.customer_get_member_home('pgtap-c4b-m'));
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000012');
insert into o values ('list_s', public.customer_list_contacts('pgtap-c4b-m'));
insert into o values ('prof_s', public.customer_get_profile('pgtap-c4b-m'));
insert into o values ('sess_s', public.get_customer_session_state('pgtap-c4b-m'));
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4b-m', '改名', null, null, null)$$), '22023:not_primary', 'H09-1 第二聯絡人不能改會員資料');
select is(pg_temp.err($$select public.customer_create_contact_invite('pgtap-c4b-m')$$), '22023:not_primary', 'H09-2 第二聯絡人不能建邀請');
select pg_temp.as_postgres();
select is((select jsonb_array_length(body -> 'contacts') from o where label = 'list_p'), 4, 'H09-3 主要聯絡人看到 4 位聯絡人');
select is((select body -> 'contacts' -> 0 ->> 'is_primary' from o where label = 'list_p'), 'true', 'H09-4 主要聯絡人排第一');
select is((select array_agg(e ->> 'contact_phone' order by e ->> 'line_display_name') from o, jsonb_array_elements(body -> 'contacts') e where label = 'list_p'),
          array[null, '0987500012', null, null], 'H09-5 主要聯絡人看得到第二聯絡人電話;自己那列 null');
select is((select array_agg(e ->> 'contact_phone' order by e ->> 'line_display_name') from o, jsonb_array_elements(body -> 'contacts') e where label = 'list_s'),
          array[null, '0987500012', null, null], 'H09-6 第二聯絡人只看得到自己的電話');
select is((select (body -> 'requests')::text || (body -> 'invites')::text from o where label = 'list_s'), '[][]', 'H09-7 第二聯絡人看不到申請 / 邀請');
select is((select jsonb_array_length(body -> 'invites') from o where label = 'list_p'), 2, 'H09-8 主要聯絡人看到有效邀請(inv4、H03-9 新建;用過 / 撤銷 / 過期的不列)');
select is((select body -> 'me' ->> 'is_primary' from o where label = 'list_s'), 'false', 'H09-9 me.is_primary');
select is((select body -> 'me' ->> 'is_primary' || '/' || (body ->> 'can_edit') || '/' || (body -> 'me' ->> 'contact_phone') from o where label = 'prof_s'),
          'false/false/0987500012', 'H09-10 我的資料:第二聯絡人 is_primary / can_edit false、contact_phone');
select is((select body -> 'member' ->> 'phone' || '/' || (body ->> 'is_primary') from o where label = 'sess_s'),
          '0987500012/false', 'H11-2 第二聯絡人 session:電話 = 自己的電話');
select is((select body -> 'member' ->> 'is_primary' from o where label = 'home_p'), 'true', 'H09-11 首頁 is_primary');
select is((select o.body::text ~ 'U-C4B-LINESUB-SENTINEL|c4b00000-0000-4000-8000-0000000000(11|12|16|17)' from o where label = 'list_p'),
          false, 'F02-1 清單搜不到 LINE userId / 帳號 id');

-- =========================================================================
-- H04 同電話 ⇒ 申請
-- =========================================================================
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
insert into o values ('h04_req', public.customer_complete_profile('pgtap-c4b-m', '0912500001', '想加入', true));
insert into o values ('h04_sess', public.get_customer_session_state('pgtap-c4b-m'));
select pg_temp.as_postgres();
select is((select body::text from o where label = 'h04_req'), '{"state": "join_pending"}', 'H04-1 已有聯絡人 ⇒ join_pending,回應只有 state');
select is((select body ->> 'state' || '/' || (body -> 'request' ->> 'phone') from o where label = 'h04_sess'), 'join_pending/0912500001', 'H04-2 session join_pending');
select is((select array_agg(target_type || ':' || title || ':' || body order by target_type) from user_notifications
           where merchant_id = 'c4b00000-0000-4000-8000-000000000031' and event_type = 'member_contact_request'),
          array['admin:有人申請成為會員的聯絡人:有人申請成為會員「王公司」的聯絡人。', 'agent:有人申請成為會員的聯絡人:有人申請成為會員「王公司」的聯絡人。'],
          'H04-3 鈴鐺 member_contact_request:管理員 + 會員客服(訂單客服不收)');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is(public.customer_complete_profile('pgtap-c4b-m', '0912500001', '想加入', true), '{"state": "join_pending"}'::jsonb, 'H04-4 重送同一支 ⇒ 冪等');
select pg_temp.as_postgres();
select is((select count(*)::int from member_contact_requests where user_id = 'c4b00000-0000-4000-8000-000000000013'), 1, 'H04-5 沒有多一筆申請');
select is((select count(*)::int from user_notifications where event_type = 'member_contact_request' and merchant_id = 'c4b00000-0000-4000-8000-000000000031'), 2, 'H04-6 沒有重發鈴鐺');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is(public.customer_complete_profile('pgtap-c4b-m', '0987500012', '想加入', true), '{"state": "join_pending"}'::jsonb,
          'H04-7 填第二聯絡人的電話 ⇒ 也是送申請給那位會員(K03,不另建會員)');
select pg_temp.as_postgres();
select is((select array_agg(status || ':' || phone_normalized order by created_at, status) from member_contact_requests where user_id = 'c4b00000-0000-4000-8000-000000000013'),
          array['cancelled:0912500001', 'pending:0987500012'], 'H04-8 同一個帳號只有 1 筆 pending(舊的 cancelled)');
select is((select count(*)::int from members where merchant_id = 'c4b00000-0000-4000-8000-000000000031'), 4, 'H04-9 沒有新建任何會員');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is(public.customer_cancel_contact_request('pgtap-c4b-m'), '{"state": "ok"}'::jsonb, 'H04-10 改用其他電話 ⇒ 取消申請');
select is(public.get_customer_session_state('pgtap-c4b-m') - 'line_picture_url' - 'line_display_name', '{"state": "needs_profile", "join_request": null}'::jsonb, 'H04-11 取消後回 needs_profile');
select is(public.customer_complete_profile('pgtap-c4b-m', '0912500001', '想加入', true), '{"state": "join_pending"}'::jsonb, 'H04-12 再送一次');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
insert into o values ('home_p2', public.customer_get_member_home('pgtap-c4b-m'));
insert into o values ('list_p2', public.customer_list_contacts('pgtap-c4b-m'));
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000012');
insert into o values ('home_s2', public.customer_get_member_home('pgtap-c4b-m'));
select pg_temp.as_postgres();
select is((select (body ->> 'pending_contact_requests') from o where label = 'home_p2'), '1', 'H04-13 主要聯絡人首頁 pending_contact_requests = 1');
select is((select (body ->> 'pending_contact_requests') from o where label = 'home_s2'), '0', 'H04-14 第二聯絡人一律 0');
select is((select (body -> 'requests' -> 0 ->> 'phone') || '/' || (body -> 'requests' -> 0 ->> 'line_display_name') from o where label = 'list_p2'),
          '0912500001/LINE13', 'H04-15 主要聯絡人看得到申請人顯示名 + 電話');
insert into o select 'req13', jsonb_build_object('id', id) from member_contact_requests where user_id = 'c4b00000-0000-4000-8000-000000000013' and status = 'pending';

-- =========================================================================
-- H05 處理申請
-- =========================================================================
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000012');
select is(pg_temp.err($$select public.customer_resolve_contact_request('pgtap-c4b-m', pg_temp.c('req13'), true)$$), '22023:not_primary', 'H05-1 第二聯絡人不能處理');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000014');
select is(public.customer_resolve_contact_request('pgtap-c4b-m', pg_temp.c('req13'), true), '{"state": "not_found"}'::jsonb, 'F03-2 別的會員的主要聯絡人處理不了(not_found)');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(public.customer_resolve_contact_request('pgtap-c4b-m', pg_temp.c('req13'), false), '{"state": "rejected"}'::jsonb, 'H05-2 拒絕');
select is(public.customer_resolve_contact_request('pgtap-c4b-m', pg_temp.c('req13'), true), '{"state": "not_found"}'::jsonb, 'H05-3 已處理的 ⇒ not_found');
select pg_temp.as_postgres();
-- 同一個交易內 now() 相同:把較早的兩筆申請時間往前挪,模擬真實先後。
update member_contact_requests set created_at = created_at - interval '1 hour'
 where user_id = 'c4b00000-0000-4000-8000-000000000013' and id <> pg_temp.c('req13');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is(public.get_customer_session_state('pgtap-c4b-m') -> 'join_request' ->> 'status', 'rejected', 'H05-4 申請人看到 rejected');
select is(public.customer_complete_profile('pgtap-c4b-m', '0912500001', '想加入', true), '{"state": "join_pending"}'::jsonb, 'H05-5 再申請');
select pg_temp.as_postgres();
delete from o where label = 'req13';
insert into o select 'req13', jsonb_build_object('id', id) from member_contact_requests where user_id = 'c4b00000-0000-4000-8000-000000000013' and status = 'pending';
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000003');
select throws_ok($$select public.merchant_resolve_contact_request(pg_temp.c('req13'), true)$$, '42501', null, 'H05-6 沒有會員權限的客服不能處理');
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000002');
select is(public.merchant_resolve_contact_request(pg_temp.c('req13'), true), '{"state": "approved"}'::jsonb, 'H05-7 會員客服在後台同意');
select pg_temp.as_postgres();
select is((select is_primary::text || '/' || joined_via || '/' || coalesce(contact_phone, '-') from member_customer_contacts
           where user_id = 'c4b00000-0000-4000-8000-000000000013' and status = 'active'),
          'false/request/-', 'H05-8 加為第二聯絡人;申請電話 = 會員電話 ⇒ 不存');
select is((select status || '/' || resolved_by_role from member_contact_requests where id = pg_temp.c('req13')), 'approved/store', 'H05-9 申請標 approved / store');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is(public.get_customer_session_state('pgtap-c4b-m') ->> 'state', 'linked', 'H05-10 申請人變 linked');
select pg_temp.as_postgres();

-- 上限 5 筆 pending、過期
insert into member_contact_requests (merchant_id, member_id, user_id, phone_normalized)
select 'c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000042', ('c4b00000-0000-4000-8000-0000000000' || s)::uuid, '0912500002'
from unnest(array['21','22','23','24','25']) s;
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000026');
select is(public.customer_complete_profile('pgtap-c4b-m', '0912500002', '第六位', true), '{"state": "phone_taken"}'::jsonb, 'H04-16 那位會員已有 5 筆待處理 ⇒ phone_taken');
select pg_temp.as_postgres();
update member_contact_requests set created_at = now() - interval '8 days' where user_id = 'c4b00000-0000-4000-8000-000000000021';
insert into o select 'req21', jsonb_build_object('id', id) from member_contact_requests where user_id = 'c4b00000-0000-4000-8000-000000000021';
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000014');
select is(public.customer_resolve_contact_request('pgtap-c4b-m', pg_temp.c('req21'), true), '{"state": "not_found"}'::jsonb, 'H05-11 超過 7 天 ⇒ not_found');
select pg_temp.as_postgres();
select is((select status from member_contact_requests where id = pg_temp.c('req21')), 'expired', 'H05-12 順手標 expired');
update member_contact_requests set created_at = now() - interval '8 days' where user_id = 'c4b00000-0000-4000-8000-000000000022';
select ok(private.expire_member_contact_requests() >= 1, 'H05-13 cron 把超過 7 天的標 expired');
select is((select status || '/' || resolved_by_role from member_contact_requests where user_id = 'c4b00000-0000-4000-8000-000000000022'), 'expired/system', 'H05-13b 狀態');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000022');
select is(public.get_customer_session_state('pgtap-c4b-m') -> 'join_request' ->> 'status', 'expired', 'H05-14 申請人看到 expired');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000026');
select is(public.customer_complete_profile('pgtap-c4b-m', '0912500002', '第六位', true), '{"state": "join_pending"}'::jsonb, 'H04-17 有名額後可以申請');
select pg_temp.as_postgres();

-- =========================================================================
-- H08 第二聯絡人電話
-- =========================================================================
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(pg_temp.err($$select public.customer_set_my_contact_phone('pgtap-c4b-m', '0987000000')$$), '22023:primary_uses_member_phone', 'H08-1 主要聯絡人不能設');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is(pg_temp.err($$select public.customer_set_my_contact_phone('pgtap-c4b-m', '12')$$), '22023:invalid_phone', 'H08-2 格式錯');
select is(public.customer_set_my_contact_phone('pgtap-c4b-m', '0912500002'), '{"state": "phone_in_use"}'::jsonb, 'H08-3 別的會員的電話 ⇒ phone_in_use');
select is(public.customer_set_my_contact_phone('pgtap-c4b-m', '0912500099'), '{"state": "phone_in_use"}'::jsonb, 'H08-4 別的會員(新客人)的電話 ⇒ phone_in_use');
select is(public.customer_set_my_contact_phone('pgtap-c4b-m', '0912500001'), '{"state": "ok", "contact_phone": null}'::jsonb, 'H08-5 跟會員電話一樣 ⇒ 存 null');
select is(public.customer_set_my_contact_phone('pgtap-c4b-m', '02-2500-0013'), '{"state": "ok", "contact_phone": "0225000013"}'::jsonb, 'H08-6 市話可以');
select is(public.customer_set_my_contact_phone('pgtap-c4b-m', ''), '{"state": "ok", "contact_phone": null}'::jsonb, 'H08-7 空 = 清掉');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000017');
select is(public.customer_set_my_contact_phone('pgtap-c4b-m', '0987500012'), '{"state": "ok", "contact_phone": "0987500012"}'::jsonb, 'H08-9 同一位會員的聯絡人可以共用電話');
select is(public.customer_set_my_contact_phone('pgtap-c4b-m', ''), '{"state": "ok", "contact_phone": null}'::jsonb, 'H08-10 清掉');
select pg_temp.as_postgres();

-- =========================================================================
-- K03 第二聯絡人電話在後台
-- =========================================================================
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select public.create_member('c4b00000-0000-4000-8000-000000000031', '重複公司', '0987-500-012')$$),
          'P0001:phone_is_member_contact', 'K03-1 create_member 撞聯絡人電話 ⇒ 擋');
select is(pg_temp.errmsg($$select public.create_member('c4b00000-0000-4000-8000-000000000031', '重複公司', '0987-500-012')$$),
          '這支電話是會員「王公司」的聯絡人電話，請直接選擇這位會員，不要另外建立新會員。', 'K03-2 訊息');
select is(pg_temp.err($$select public.update_member('c4b00000-0000-4000-8000-000000000043', '空會員', '0987500012', null, null, null)$$),
          'P0001:phone_is_member_contact', 'K03-3 update_member 改成別的會員的聯絡人電話 ⇒ 擋');
select is(pg_temp.err($$select public.update_member('c4b00000-0000-4000-8000-000000000041', '王公司', '0912500001', null, null, null)$$),
          'ok', 'K03-4 會員自己改資料不受影響');
select is(pg_temp.err($$select public.create_booking(
            p_merchant_id => 'c4b00000-0000-4000-8000-000000000031', p_staff_id => 'c4b00000-0000-4000-8000-000000000051',
            p_service_items => '[{"service_item_id":"c4b00000-0000-4000-8000-000000000061","quantity":1,"unit_price":500}]'::jsonb,
            p_start_at => timestamptz '2027-05-03 10:00:00+08', p_customer_name => '小李', p_customer_phone => '0987500012',
            p_payment_method_id => 'c4b00000-0000-4000-8000-000000000062')$$),
          'P0001:phone_is_member_contact', 'K03-5 後台建單沒選會員直接送出 ⇒ 擋下');
select is(pg_temp.errmsg($$select public.create_booking(
            p_merchant_id => 'c4b00000-0000-4000-8000-000000000031', p_staff_id => 'c4b00000-0000-4000-8000-000000000051',
            p_service_items => '[{"service_item_id":"c4b00000-0000-4000-8000-000000000061","quantity":1,"unit_price":500}]'::jsonb,
            p_start_at => timestamptz '2027-05-03 10:00:00+08', p_customer_name => '小李', p_customer_phone => '0987500012',
            p_payment_method_id => 'c4b00000-0000-4000-8000-000000000062',
            p_member_id => 'c4b00000-0000-4000-8000-000000000041')$$),
          'ok', 'K03-6 選了那位會員就可以建單');
select is((select jsonb_agg(e ->> 'member_id' || ':' || coalesce(e ->> 'matched_contact_phone', '-'))
           from jsonb_array_elements(public.get_members_by_phone('c4b00000-0000-4000-8000-000000000031', '0987500012')) e),
          '["c4b00000-0000-4000-8000-000000000041:0987500012"]'::jsonb, 'K03-7 建單電話提示找得到(matched_contact_phone)');
select is((select jsonb_agg(e ->> 'member_id' || ':' || coalesce(e ->> 'matched_contact_phone', '-'))
           from jsonb_array_elements(public.get_members_by_phone('c4b00000-0000-4000-8000-000000000031', '0912500001')) e),
          '["c4b00000-0000-4000-8000-000000000041:-"]'::jsonb, 'K03-8 會員電話比對到 ⇒ matched_contact_phone null');
select is(public.search_members_by_contact_phone('c4b00000-0000-4000-8000-000000000031', '500012'),
          '[{"member_id": "c4b00000-0000-4000-8000-000000000041", "contact_phone": "0987500012"}]'::jsonb, 'K03-9 會員列表搜尋聯絡人電話');
select is(public.search_members_by_contact_phone('c4b00000-0000-4000-8000-000000000031', '012'), '[]'::jsonb, 'K03-10 少於 4 碼不比對');
-- 主腦裁決(風險 2,方案 ①):建單紅利預覽認得聯絡人電話 ⇒ member_contact(帶會員 id / 姓名),送出仍擋
create function pg_temp.pv(p_booking uuid, p_phone text) returns jsonb language sql as $$
  select public.preview_booking_points('c4b00000-0000-4000-8000-000000000031', p_booking, null, p_phone,
    '[{"service_item_id":"c4b00000-0000-4000-8000-000000000061","quantity":1,"unit_price":500}]'::jsonb,
    false, null, false, null, null, false, null, null) -> 'member'
$$;
grant execute on function pg_temp.pv(uuid, text) to authenticated;
select is(pg_temp.pv(null, '0987-500-012'),
          '{"resolution": "member_contact", "member_id": "c4b00000-0000-4000-8000-000000000041", "name": "王公司", "balance": null}'::jsonb,
          'PV-1 新增模式:第二聯絡人電話 ⇒ member_contact + 會員 id / 姓名(不帶餘額)');
select is(pg_temp.pv(null, '0912500001') ->> 'resolution', 'existing', 'PV-2 會員電話照舊 existing');
select is(pg_temp.pv(null, '0912777777'), '{"resolution": "new", "member_id": null, "name": null, "balance": null}'::jsonb, 'PV-3 沒人用的電話照舊 new');
select pg_temp.as_postgres();
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source, member_id)
values ('c4b00000-0000-4000-8000-0000000000e1', 'c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000051',
        now() + interval '20 days', now() + interval '20 days 1 hour', '空會員', '0912500003', 'admin', 'pending_confirmation', 'manual',
        'c4b00000-0000-4000-8000-000000000043');
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000001');
select is(pg_temp.pv('c4b00000-0000-4000-8000-0000000000e1', '0987500012') ->> 'resolution', 'member_contact', 'PV-4 編輯改成聯絡人電話 ⇒ member_contact');
select is(pg_temp.pv('c4b00000-0000-4000-8000-0000000000e1', '0912500003') ->> 'resolution', 'none', 'PV-5 電話沒改、沒帶會員 ⇒ 照舊 none(既有規則不變)');
select is(pg_temp.err($$select public.update_booking(
            p_booking_id => 'c4b00000-0000-4000-8000-0000000000e1', p_staff_id => 'c4b00000-0000-4000-8000-000000000051',
            p_service_items => '[{"service_item_id":"c4b00000-0000-4000-8000-000000000061","quantity":1,"unit_price":500}]'::jsonb,
            p_start_at => (select start_at from bookings where id = 'c4b00000-0000-4000-8000-0000000000e1'),
            p_customer_name => '空會員', p_customer_phone => '0987500012',
            p_member_id => 'c4b00000-0000-4000-8000-000000000043',
            p_payment_method_id => 'c4b00000-0000-4000-8000-000000000062')$$),
          'P0001:phone_is_member_contact', 'PV-6 送出仍擋(update_booking 換成聯絡人電話)');
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000003');
select throws_ok($$select public.search_members_by_contact_phone('c4b00000-0000-4000-8000-000000000031', '500012')$$, '42501', null, 'K03-11 沒有會員權限 ⇒ 42501');
select pg_temp.as_postgres();
select is(private.resolve_guest_member('c4b00000-0000-4000-8000-000000000031', '0987500012', '訪客'), 'c4b00000-0000-4000-8000-000000000041'::uuid,
          'K03-12 訪客用聯絡人電話 ⇒ 掛那位會員');
select is((select count(*)::int from members where merchant_id = 'c4b00000-0000-4000-8000-000000000031'), 4, 'K03-13 沒有建出重複會員');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000018');
select is(public.customer_complete_profile('pgtap-c4b-m', '0987500012', '小李同事', true), '{"state": "join_pending"}'::jsonb,
          'K03-14 LINE 加入填聯絡人電話 ⇒ 送申請(不建會員)');
select pg_temp.as_postgres();

-- =========================================================================
-- H10 booked_by / 移除 / 轉移 / 退出
-- =========================================================================
insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, created_by_user_id, status, source, member_id)
values ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000051', now() + interval '5 days', now() + interval '5 days 1 hour',
        '王公司', '0987500012', 'customer', 'c4b00000-0000-4000-8000-000000000012', 'pending_confirmation', 'customer', 'c4b00000-0000-4000-8000-000000000041'),
       ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000051', now() + interval '6 days', now() + interval '6 days 1 hour',
        'C4B_OTHER_MEMBER_SENTINEL', '0912500002', 'customer', 'c4b00000-0000-4000-8000-000000000014', 'pending_confirmation', 'customer', 'c4b00000-0000-4000-8000-000000000042');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is((select jsonb_agg(e ->> 'booked_by') from jsonb_array_elements(public.customer_list_my_bookings('pgtap-c4b-m', 'upcoming') -> 'items') e),
          '["LINE12", null]'::jsonb, 'H10-1 多位聯絡人的會員 ⇒ 聯絡人線上下的單 booked_by = 下單聯絡人;後台建的單 null');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000014');
select is((select jsonb_agg(e -> 'booked_by') from jsonb_array_elements(public.customer_list_my_bookings('pgtap-c4b-m', 'upcoming') -> 'items') e),
          '[null]'::jsonb, 'H10-2 只有一位聯絡人的會員 ⇒ booked_by null');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is((select jsonb_array_length(public.customer_list_my_bookings('pgtap-c4b-m', 'upcoming') -> 'items')), 2, 'H10-3 第二聯絡人看到同一份預約');

select pg_temp.as_postgres();
insert into o select 'c12', jsonb_build_object('id', id) from member_customer_contacts where user_id = 'c4b00000-0000-4000-8000-000000000012' and status = 'active';
insert into o select 'c13', jsonb_build_object('id', id) from member_customer_contacts where user_id = 'c4b00000-0000-4000-8000-000000000013' and status = 'active';
insert into o select 'c11', jsonb_build_object('id', id) from member_customer_contacts where user_id = 'c4b00000-0000-4000-8000-000000000011' and status = 'active';
insert into o select 'c14', jsonb_build_object('id', id) from member_customer_contacts where user_id = 'c4b00000-0000-4000-8000-000000000014' and status = 'active';
insert into o select 'c16', jsonb_build_object('id', id) from member_customer_contacts where user_id = 'c4b00000-0000-4000-8000-000000000016' and status = 'active';
insert into o select 'c17', jsonb_build_object('id', id) from member_customer_contacts where user_id = 'c4b00000-0000-4000-8000-000000000017' and status = 'active';

select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000012');
select is(pg_temp.err($$select public.customer_remove_contact('pgtap-c4b-m', pg_temp.c('c13'))$$), '22023:not_primary', 'H10-4 第二聯絡人不能移除別人');
select is(pg_temp.err($$select public.customer_transfer_primary('pgtap-c4b-m', pg_temp.c('c12'))$$), '22023:not_primary', 'H10-5 第二聯絡人不能轉移');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(public.customer_remove_contact('pgtap-c4b-m', pg_temp.c('c11')), '{"state": "not_found"}'::jsonb, 'H10-6 不能移除自己(主要)');
select is(public.customer_remove_contact('pgtap-c4b-m', pg_temp.c('c14')), '{"state": "not_found"}'::jsonb, 'F03-3 別的會員的聯絡人 ⇒ not_found');
select is(public.customer_transfer_primary('pgtap-c4b-m', pg_temp.c('c14')), '{"state": "not_found"}'::jsonb, 'F03-4 轉給別的會員的聯絡人 ⇒ not_found');
select is(public.customer_remove_contact('pgtap-c4b-m', pg_temp.c('c13')), '{"state": "ok"}'::jsonb, 'H10-7 主要聯絡人移除第二聯絡人');
insert into tok select 'inv7', split_part(public.customer_create_contact_invite('pgtap-c4b-m') ->> 'path', '/', 5);
select pg_temp.as_postgres();
select is((select status || '/' || removed_via || '/' || removed_by_user_id from member_customer_contacts where id = pg_temp.c('c13')),
          'removed/primary/c4b00000-0000-4000-8000-000000000011', 'H10-8 標 removed');
select is((select count(*)::int from customer_member_link_blocks where member_id = 'c4b00000-0000-4000-8000-000000000041' and user_id = 'c4b00000-0000-4000-8000-000000000013'),
          1, 'H10-9 寫封鎖');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000013');
select is(public.customer_get_member_home('pgtap-c4b-m'), '{"state": "not_linked"}'::jsonb, 'H10-10 被移除的人 ⇒ not_linked(等於登出)');
select is(public.customer_complete_profile('pgtap-c4b-m', '0912500001', '再來', true), '{"state": "phone_taken"}'::jsonb, 'H10-11 被移除的人填同一支電話 ⇒ phone_taken(不是申請)');
select is(public.customer_accept_contact_invite('pgtap-c4b-m', (select t from tok where k = 'inv7'), null, true), '{"state": "invalid"}'::jsonb, 'H10-12 被移除的人用有效邀請 ⇒ invalid');

select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(public.customer_transfer_primary('pgtap-c4b-m', pg_temp.c('c12')), '{"state": "ok"}'::jsonb, 'H10-13 轉移主要給 12');
select pg_temp.as_postgres();
select is((select user_id::text || '/' || line_user_id || '/' || line_bound || '/' || phone from members where id = 'c4b00000-0000-4000-8000-000000000041'),
          'c4b00000-0000-4000-8000-000000000012/U-C4B-LINESUB-SENTINEL-12/true/0912500001', 'H10-14 members 同步新主要;會員電話不變');
select is((select is_primary::text || '/' || coalesce(contact_phone, '-') from member_customer_contacts where id = pg_temp.c('c12')), 'true/-', 'H10-15 新主要的聯絡人電話清掉');
select is((select is_primary::text from member_customer_contacts where id = pg_temp.c('c11')), 'false', 'H10-16 原主要變第二聯絡人');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(pg_temp.err($$select public.customer_update_profile('pgtap-c4b-m', '王公司', null, null, null)$$), '22023:not_primary', 'H10-17 原主要不能再改會員資料');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000012');
select is(public.customer_update_profile('pgtap-c4b-m', '王公司', null, null, null) ->> 'state', 'ok', 'H10-18 新主要可以改');
select is(public.customer_leave_member('pgtap-c4b-m'), '{"state": "primary_has_others"}'::jsonb, 'H10-19 主要聯絡人還有別人 ⇒ 不能退出');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(public.customer_leave_member('pgtap-c4b-m'), '{"state": "ok"}'::jsonb, 'H10-20 第二聯絡人退出');
select is(public.customer_get_profile('pgtap-c4b-m'), '{"state": "not_linked"}'::jsonb, 'H10-21 退出後 not_linked');
select pg_temp.as_postgres();
select is((select count(*)::int from customer_member_link_blocks where user_id = 'c4b00000-0000-4000-8000-000000000011'), 0, 'H10-22 退出不封鎖');

-- =========================================================================
-- K04 後台
-- =========================================================================
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000003');
select throws_ok($$select public.list_member_contacts('c4b00000-0000-4000-8000-000000000041')$$, '42501', null, 'K04-1 沒有會員權限 ⇒ 42501');
select throws_ok($$select public.merchant_set_primary_contact(pg_temp.c('c16'))$$, '42501', null, 'K04-2 沒有會員權限不能指定主要');
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000001');
insert into o values ('k04_list', public.list_member_contacts('c4b00000-0000-4000-8000-000000000041'));
select pg_temp.as_postgres();
select is((select array_agg(e ->> 'line_display_name' || ':' || (e ->> 'is_primary') || ':' || (e ->> 'joined_via') order by e ->> 'line_display_name')
           from o, jsonb_array_elements(body -> 'contacts') e where label = 'k04_list'),
          array['LINE12:true:invite', 'LINE16:false:invite', 'LINE17:false:invite'], 'K04-3 後台聯絡人清單');
select is((select body ->> 'relink_blocked' from o where label = 'k04_list'), 'true', 'K04-4 relink_blocked');
select is((select body::text ~ 'U-C4B-LINESUB-SENTINEL|"user_id"' from o where label = 'k04_list'), false, 'K04-5 回傳不含 LINE userId / user_id');
select is((select jsonb_object_keys(body -> 'contacts' -> 0) from o where label = 'k04_list' order by 1 limit 1), 'contact_phone', 'K04-6 欄位');
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000002');
select is(public.merchant_remove_member_contact(pg_temp.c('c12')), '{"state": "need_new_primary"}'::jsonb, 'K04-7 移除主要聯絡人要先選新的');
select is(public.merchant_remove_member_contact(pg_temp.c('c12'), pg_temp.c('c14')), '{"state": "not_found"}'::jsonb, 'K04-8 新主要不是這位會員的聯絡人 ⇒ not_found');
select is(public.merchant_remove_member_contact(pg_temp.c('c12'), pg_temp.c('c16')), '{"state": "ok"}'::jsonb, 'K04-9 移除主要 + 指定新主要');
select pg_temp.as_postgres();
select is((select user_id from members where id = 'c4b00000-0000-4000-8000-000000000041'), 'c4b00000-0000-4000-8000-000000000016'::uuid, 'K04-10 members 同步');
select is((select removed_via from member_customer_contacts where id = pg_temp.c('c12')), 'store', 'K04-11 removed_via store');
select is((select count(*)::int from customer_member_link_blocks where user_id = 'c4b00000-0000-4000-8000-000000000012'), 1, 'K04-12 店家移除也封鎖');
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000002');
select is(public.merchant_set_primary_contact(pg_temp.c('c17')), '{"state": "ok"}'::jsonb, 'K04-13 後台指定主要');
select pg_temp.as_postgres();
select is((select user_id from members where id = 'c4b00000-0000-4000-8000-000000000041'), 'c4b00000-0000-4000-8000-000000000017'::uuid, 'K04-14 members 同步');
select is((select count(*)::int from member_customer_contacts where member_id = 'c4b00000-0000-4000-8000-000000000041' and is_primary and status = 'active'), 1, 'K04-15 主要只有一位');

-- =========================================================================
-- H11 unbind:清掉全部聯絡人 + 全部封鎖
-- =========================================================================
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000001');
select lives_ok($$select public.unbind_line_account('member', 'c4b00000-0000-4000-8000-000000000041')$$, 'H11-3 解除 LINE 綁定');
select pg_temp.as_postgres();
select is((select count(*)::int from member_customer_contacts where member_id = 'c4b00000-0000-4000-8000-000000000041' and status = 'active'), 0, 'H11-4 聯絡人全部清掉');
select is((select array_agg(distinct removed_via) from member_customer_contacts where member_id = 'c4b00000-0000-4000-8000-000000000041' and user_id in ('c4b00000-0000-4000-8000-000000000016', 'c4b00000-0000-4000-8000-000000000017')),
          array['unbind'], 'H11-5 removed_via unbind');
select is((select count(*)::int from customer_member_link_blocks where member_id = 'c4b00000-0000-4000-8000-000000000041'
           and user_id in ('c4b00000-0000-4000-8000-000000000016', 'c4b00000-0000-4000-8000-000000000017')), 2, 'H11-6 全部封鎖');
select is((select coalesce(user_id::text, '-') || '/' || coalesce(line_user_id, '-') || '/' || line_bound from members where id = 'c4b00000-0000-4000-8000-000000000041'),
          '-/-/false', 'H11-7 members 清空');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000017');
select is(public.get_customer_session_state('pgtap-c4b-m') ->> 'state', 'needs_profile', 'H11-8 被解除的人回 needs_profile');

-- =========================================================================
-- 主腦裁決(風險 4):跨店搬會員 ⇒ 清掉聯絡人、取消申請、撤銷邀請,同步 members;不封鎖
-- =========================================================================
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000014');
select is(public.customer_create_contact_invite('pgtap-c4b-m') ->> 'state', 'ok', 'TR-0 M2 主要聯絡人先建一張邀請');
select pg_temp.as_postgres();
insert into merchant_admins (merchant_id, user_id) values ('c4b00000-0000-4000-8000-000000000032', 'c4b00000-0000-4000-8000-000000000001');
select ok((select count(*) from member_contact_requests where member_id = 'c4b00000-0000-4000-8000-000000000042' and status = 'pending') > 0, 'TR-1 搬之前 M2 有待處理申請');
select pg_temp.as_user('c4b00000-0000-4000-8000-000000000001');
select lives_ok($$select public.transfer_members_to_merchant('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000032',
                  array['c4b00000-0000-4000-8000-000000000042']::uuid[])$$, 'TR-2 搬會員成功');
select pg_temp.as_postgres();
select is((select merchant_id::text || '/' || coalesce(user_id::text, '-') || '/' || coalesce(line_user_id, '-') || '/' || line_bound
           from members where id = 'c4b00000-0000-4000-8000-000000000042'),
          'c4b00000-0000-4000-8000-000000000032/-/-/false', 'TR-3 會員搬到新店,user_id / line_user_id / line_bound 清空');
select is((select string_agg(status || ':' || coalesce(removed_via, '-'), ',') from member_customer_contacts where member_id = 'c4b00000-0000-4000-8000-000000000042'),
          'removed:transfer', 'TR-4 聯絡人標 removed(transfer)');
select is((select count(*)::int from member_contact_requests where member_id = 'c4b00000-0000-4000-8000-000000000042' and status = 'pending'), 0, 'TR-5 待處理申請全部取消');
select is((select count(*)::int from member_contact_invites where member_id = 'c4b00000-0000-4000-8000-000000000042' and revoked_at is null and used_at is null), 0, 'TR-6 有效邀請全部撤銷');
select is((select count(*)::int from customer_member_link_blocks where member_id = 'c4b00000-0000-4000-8000-000000000042'), 0, 'TR-7 不寫封鎖');
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000014');
select is(public.get_customer_session_state('pgtap-c4b-m') ->> 'state', 'needs_profile', 'TR-8 原聯絡人在舊店回 needs_profile');
select pg_temp.as_postgres();

-- =========================================================================
-- F01 權限
-- =========================================================================
select pg_temp.as_postgres();
select is((select array_agg(p.proname::text || ':' || has_function_privilege('anon', p.oid, 'execute')::text || has_function_privilege('authenticated', p.oid, 'execute')::text
                            || has_function_privilege('service_role', p.oid, 'execute')::text order by p.proname)
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
             'customer_cancel_contact_request', 'customer_create_contact_invite', 'customer_revoke_contact_invite', 'customer_peek_contact_invite',
             'customer_accept_contact_invite', 'customer_list_contacts', 'customer_resolve_contact_request', 'customer_remove_contact',
             'customer_leave_member', 'customer_transfer_primary', 'customer_set_my_contact_phone', 'list_member_contacts',
             'merchant_set_primary_contact', 'merchant_remove_member_contact', 'merchant_resolve_contact_request',
             'search_members_by_contact_phone', 'internal_customer_contact_invite_claim', 'internal_customer_line_login_start')),
          array['customer_accept_contact_invite:falsetruetrue', 'customer_cancel_contact_request:falsetruetrue', 'customer_create_contact_invite:falsetruetrue',
                'customer_leave_member:falsetruetrue', 'customer_list_contacts:falsetruetrue', 'customer_peek_contact_invite:truetruetrue',
                'customer_remove_contact:falsetruetrue', 'customer_resolve_contact_request:falsetruetrue', 'customer_revoke_contact_invite:falsetruetrue',
                'customer_set_my_contact_phone:falsetruetrue', 'customer_transfer_primary:falsetruetrue', 'internal_customer_contact_invite_claim:falsefalsetrue',
                'internal_customer_line_login_start:falsefalsetrue', 'list_member_contacts:falsetruetrue', 'merchant_remove_member_contact:falsetruetrue',
                'merchant_resolve_contact_request:falsetruetrue', 'merchant_set_primary_contact:falsetruetrue', 'search_members_by_contact_phone:falsetruetrue'],
          'F01-1 新函式權限:客人 / 後台只給 authenticated、peek 加 anon、internal 只給 service_role');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in (
             'contact_user_lock', 'member_sync_primary', 'member_contact_add', 'member_contact_remove', 'member_id_by_contact_phone',
             'phone_in_use_elsewhere', 'assert_phone_not_member_contact', 'contact_invite_valid_id', 'notify_member_managers',
             'notify_member_contact_joined', 'notify_member_contact_request', 'member_contact_request_create', 'resolve_contact_request',
             'expire_member_contact_requests')
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
          0, 'F01-2 private 新函式 anon / authenticated 都不能執行');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in (
             'contact_user_lock', 'member_sync_primary', 'member_contact_add', 'member_contact_remove', 'member_id_by_contact_phone',
             'phone_in_use_elsewhere', 'assert_phone_not_member_contact', 'contact_invite_valid_id', 'notify_member_managers',
             'notify_member_contact_joined', 'notify_member_contact_request', 'member_contact_request_create', 'resolve_contact_request',
             'expire_member_contact_requests')), 14, 'F01-3 private 新函式都在');
select is((select count(*)::int from pg_policy p join pg_roles r on r.oid = any(p.polroles) where r.rolname = 'anon'), 0, 'F01-4 anon policy 仍是 0');
select pg_temp.as_anon();
select throws_ok($$select public.customer_list_contacts('pgtap-c4b-m')$$, '42501', null, 'F01-5 anon 不能叫客人函式');
select pg_temp.as_postgres();

-- QA 低-1 守門:改第二聯絡人電話要先鎖會員列(跟轉移主要同一把鎖)、鎖後重讀身分,UPDATE 只改非主要
select ok((select prosrc ~ 'from public\.members where id = v_ctx\.member_id for update'
                  and prosrc ~ 'and not is_primary'
                  and position('for update' in prosrc) < position('update public.member_customer_contacts' in prosrc)
           from pg_proc where oid = 'public.customer_set_my_contact_phone(text, text)'::regprocedure),
          'QA-L1 customer_set_my_contact_phone 本體:先 for update 鎖會員列、UPDATE 加 not is_primary');

-- F02 哨兵:所有客人回應搜不到其他會員姓名 / 備註 / LINE userId
select is((select array_agg(label order by label) from o
           where label not like 'k04%' and body::text ~ 'C4B_OTHER_MEMBER_SENTINEL|C4B_MEMBER_NOTES_SENTINEL|U-C4B-LINESUB-SENTINEL'),
          null, 'F02-2 客人回應(清單、首頁、我的資料、申請、邀請)搜不到哨兵');

select * from finish();
rollback;
