-- 客戶端第 2 批 — C2-C03 customer_complete_profile(零之二版)、C2-C05 get_customer_session_state、
-- C2-D03 接上既有會員 + 鈴鐺、C2-C06 同意紀錄、C2-F05 / F06、C2-H01、C2-H02、C2-H03
begin;

select plan(58);

create function pg_temp.as_user(p_user_id uuid, p_role text default 'authenticated', p_account_type text default null)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', p_role,
                      'app_metadata', case when p_account_type is null then '{}'::json else json_build_object('account_type', p_account_type) end)::text,
    true);
  execute format('set local role %I', p_role);
end;
$$;
create function pg_temp.as_customer(p_user_id uuid) returns void language plpgsql as $$
begin
  perform pg_temp.as_user(p_user_id, 'authenticated', 'customer');
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
grant execute on function pg_temp.as_user(uuid, text, text) to anon, authenticated;
grant execute on function pg_temp.as_customer(uuid) to anon, authenticated;
grant execute on function pg_temp.as_postgres() to anon, authenticated;

-- =========================================================================
-- Fixture
--   店 M(啟用 LINE 登入,channel 1111111111)、店 N(啟用,channel 2222222222)
--   客人 A、B、D、E(channel 1111111111),客人 C(channel 2222222222)
--   後台:管理員 ADM、有會員權限客服 AGM、沒有會員權限客服 AGO
-- =========================================================================
insert into auth.users (id, email) values
  ('c2b00000-0000-4000-8000-0000000000a1', 'pgtap-c2p-admin@test.local'),
  ('c2b00000-0000-4000-8000-0000000000a2', 'pgtap-c2p-agent-members@test.local'),
  ('c2b00000-0000-4000-8000-0000000000a3', 'pgtap-c2p-agent-orders@test.local'),
  ('c2b00000-0000-4000-8000-0000000000a4', 'pgtap-c2p-normal-user@test.local');
insert into auth.users (id, email, raw_app_meta_data)
select ('c2b00000-0000-4000-8000-0000000000' || s)::uuid, 'line-pgtap-c2p-' || s || '@customer.miaoyue.invalid', '{"account_type":"customer"}'
from unnest(array['c1', 'c2', 'c3', 'c4', 'c5', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']) s;

insert into groups (id) values ('c2b00000-0000-4000-8000-000000000011'), ('c2b00000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c2b00000-0000-4000-8000-000000000021', 'c2b00000-0000-4000-8000-000000000011', 'C2 會員店', 'in_store_beauty', 'pgtap-c2p-m', 'active'),
  ('c2b00000-0000-4000-8000-000000000022', 'c2b00000-0000-4000-8000-000000000012', 'C2 別家', 'in_store_beauty', 'pgtap-c2p-n', 'active');
insert into merchant_admins (merchant_id, user_id) values
  ('c2b00000-0000-4000-8000-000000000021', 'c2b00000-0000-4000-8000-0000000000a1');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c2b00000-0000-4000-8000-000000000031', 'c2b00000-0000-4000-8000-000000000021', 'c2b00000-0000-4000-8000-0000000000a2', '會員客服', 'pgtap-c2p-agent-members@test.local', 'active', now(), '0900170131'),
  ('c2b00000-0000-4000-8000-000000000032', 'c2b00000-0000-4000-8000-000000000021', 'c2b00000-0000-4000-8000-0000000000a3', '訂單客服', 'pgtap-c2p-agent-orders@test.local', 'active', now(), '0900170132');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c2b00000-0000-4000-8000-000000000031', 'members', true),
  ('c2b00000-0000-4000-8000-000000000032', 'orders', true);
insert into merchant_member_settings (merchant_id, policy_enabled, policy_content) values
  ('c2b00000-0000-4000-8000-000000000021', true, '會員政策內容');

-- 設定(直接寫表,Vault id 用假值;這支測試不測 Vault)
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c2b00000-0000-4000-8000-000000000021', '1111111111', gen_random_uuid(), 'abcd', true),
  ('c2b00000-0000-4000-8000-000000000022', '2222222222', gen_random_uuid(), 'abcd', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name, picture_url)
select ('c2b00000-0000-4000-8000-0000000000' || s)::uuid, case when s = 'c3' then '2222222222' else '1111111111' end,
       'U' || s || 'SENTINEL_LINE_SUB', 'LINE名' || s, 'https://profile.line-scdn.net/' || s
from unnest(array['c1', 'c2', 'c3', 'c4', 'c5']) s;

-- 既有會員(後台建的,沒有客戶帳號):SENTINEL_EXISTING_MEMBER
insert into members (id, merchant_id, name, phone, birthday, points_balance, referral_code, is_blacklisted, line_user_id, line_bound) values
  ('c2b00000-0000-4000-8000-000000000041', 'c2b00000-0000-4000-8000-000000000021', 'SENTINEL_EXISTING_MEMBER', '0912-170-141',
   '1990-01-02', 77, 'C2PTEST1', true, 'UOLDLINEUSER', true);
-- 已被別的客戶帳號(d1)接上的既有會員
insert into members (id, merchant_id, name, phone, referral_code, user_id) values
  ('c2b00000-0000-4000-8000-000000000042', 'c2b00000-0000-4000-8000-000000000021', 'SENTINEL_TAKEN_MEMBER', '0912170142', 'C2PTEST2',
   'c2b00000-0000-4000-8000-0000000000d1');
-- 已下架、但佔著客人 B 的 user_id 的舊會員
insert into members (id, merchant_id, name, phone, referral_code, user_id, status) values
  ('c2b00000-0000-4000-8000-000000000043', 'c2b00000-0000-4000-8000-000000000021', '下架舊會員', '0912170143', 'C2PTEST3',
   'c2b00000-0000-4000-8000-0000000000c2', 'removed');
-- Q6 試探用:5 支已被別人接上的電話
insert into members (merchant_id, name, phone, referral_code, user_id)
select 'c2b00000-0000-4000-8000-000000000021', 'SENTINEL_PROBE_' || i, '091217020' || i, 'C2PPRB' || i,
       ('c2b00000-0000-4000-8000-0000000000d' || (i + 1))::uuid
from generate_series(1, 5) i;

create temp table c2p_out (label text, body text);
grant all on c2p_out to anon, authenticated;

-- =========================================================================
-- C2-C05 session state
-- =========================================================================
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a1', 'anon');
select throws_ok($$select public.get_customer_session_state('pgtap-c2p-m')$$, '42501', null, 'C05-1 anon 沒有執行權限');
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a1');
select is(public.get_customer_session_state('pgtap-c2p-m'), '{"state": "not_customer"}'::jsonb, 'C05-2 後台帳號 ⇒ not_customer');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c3');
select is(public.get_customer_session_state('pgtap-c2p-m'), '{"state": "channel_mismatch"}'::jsonb, 'C05-3 別的 channel 的客人 ⇒ channel_mismatch');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c1');
select is(public.get_customer_session_state('pgtap-c2p-nope'), '{"state": "line_login_unavailable"}'::jsonb, 'C05-4 代碼不存在 ⇒ line_login_unavailable');
select is(public.get_customer_session_state('pgtap-c2p-m'),
          '{"state": "needs_profile", "line_display_name": "LINE名c1", "line_picture_url": "https://profile.line-scdn.net/c1"}'::jsonb,
          'C05-5 還沒接上 ⇒ needs_profile + 自己的 LINE 名稱頭像');

-- =========================================================================
-- C2-C03 輸入檢查
-- =========================================================================
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a1');
select throws_ok($$select public.customer_complete_profile('pgtap-c2p-m', '0912170101', '王', true)$$, '42501',
                 '這個功能只給用 LINE 登入的客人使用。', 'C03-1 後台帳號不能呼叫');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c1');
select throws_ok($$select public.customer_complete_profile('pgtap-c2p-m', '0912170101', '王', false)$$, '22023',
                 '請先勾選同意會員政策與隱私權政策。', 'C03-2 沒勾同意');
select throws_ok($$select public.customer_complete_profile('pgtap-c2p-m', '0012345678', '王', true)$$, '22023', null, 'C03-3 00 開頭不是有效電話');
select throws_ok($$select public.customer_complete_profile('pgtap-c2p-m', '02-1234-5678#12', '王', true)$$, '22023', null, 'C03-4 不收分機');
select throws_ok($$select public.customer_complete_profile('pgtap-c2p-m', '0912170101', repeat('名', 51), true)$$, '22023', null, 'C03-5 姓名超過 50 字');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c3');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912170101', '王', true), '{"state": "channel_mismatch"}'::jsonb, 'C03-6 channel 不同 ⇒ channel_mismatch');

-- =========================================================================
-- 新電話 ⇒ 直接建會員(市話也可以)
-- =========================================================================
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c1');
select is(public.customer_complete_profile('pgtap-c2p-m', '(02) 2345-6789', '  ', true), '{"state": "linked", "created": true}'::jsonb,
          'C03-7 新的市話 ⇒ 直接建會員並接上');
select pg_temp.as_postgres();
select is((select name || '/' || phone || '/' || line_user_id || '/' || line_bound || '/' || identity_verified_via || '/'
                  || (identity_verified_at is not null and identity_first_verified_at is not null) || '/' || (created_by_user_id = user_id)
           from members where user_id = 'c2b00000-0000-4000-8000-0000000000c1'),
          'LINE名c1/0223456789/Uc1SENTINEL_LINE_SUB/true/line/true/true',
          'C03-8 姓名空白用 LINE 名稱;電話存數字;LINE / 身分三欄都寫好');
select is((select count(*)::int from user_notifications where merchant_id = 'c2b00000-0000-4000-8000-000000000021'), 0, 'C03-9 新建會員不發鈴鐺');
select is((select member_policy_enabled || '/' || member_policy_hash || '/' || privacy_policy_version || '/' || context || '/' || phone_normalized || '/' || (member_id is not null)
           from customer_policy_consents where user_id = 'c2b00000-0000-4000-8000-0000000000c1'),
          'true/' || md5('會員政策內容') || '/2026-10-08/line_login/0223456789/true', 'C06-1 同意紀錄:政策開啟、內容 md5、版本、電話');

select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c1');
select is(public.get_customer_session_state('pgtap-c2p-m') -> 'member', '{"name": "LINE名c1", "phone": "0223456789"}'::jsonb,
          'C05-6 接上後 ⇒ linked + 自己的會員姓名電話');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912999999', '別的名字', true), '{"state": "linked"}'::jsonb,
          'C03-10 已接上再送一次 ⇒ linked,不建新的、不改電話');
select pg_temp.as_postgres();
select is((select count(*)::int from members where merchant_id = 'c2b00000-0000-4000-8000-000000000021' and created_by_user_id = 'c2b00000-0000-4000-8000-0000000000c1'), 1,
          'C03-11 只有一筆會員');

-- =========================================================================
-- 既有會員(沒人接上)⇒ 直接接上 + 鈴鐺;舊會員佔著 user_id 先清掉
-- =========================================================================
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c2');
insert into c2p_out values ('existing', public.customer_complete_profile('pgtap-c2p-m', '0912170141', '亂填的名字', true)::text);
select pg_temp.as_postgres();
select is((select body::jsonb from c2p_out where label = 'existing'), '{"state": "linked", "existing": true}'::jsonb, 'D03-1 既有會員 ⇒ linked existing');
select is((select name || '/' || birthday || '/' || points_balance || '/' || is_blacklisted || '/' || user_id || '/' || line_user_id || '/' || identity_verified_via
           from members where id = 'c2b00000-0000-4000-8000-000000000041'),
          'SENTINEL_EXISTING_MEMBER/1990-01-02/77/true/c2b00000-0000-4000-8000-0000000000c2/Uc2SENTINEL_LINE_SUB/line',
          'D03-2 姓名生日點數黑名單不動;user_id 接上;原本的 LINE 直接取代');
select is((select user_id from members where id = 'c2b00000-0000-4000-8000-000000000043'), null, 'D03-3 同店下架舊會員佔著的 user_id 被清掉');
select is((select array_agg(target_type || ':' || user_id order by target_type) from user_notifications
           where merchant_id = 'c2b00000-0000-4000-8000-000000000021' and event_type = 'member_line_login_linked'),
          array['admin:c2b00000-0000-4000-8000-0000000000a1', 'agent:c2b00000-0000-4000-8000-0000000000a2'],
          'D03-4 鈴鐺:管理員 + 有會員權限的客服(沒有會員權限的客服不收)');
select is((select title || '|' || body from user_notifications where user_id = 'c2b00000-0000-4000-8000-0000000000a1' and event_type = 'member_line_login_linked'),
          '會員已用 LINE 登入接上|會員「SENTINEL_EXISTING_MEMBER」已用 LINE 登入，接上原本的會員資料。', 'D03-5 鈴鐺文字');

-- =========================================================================
-- 已被別的客戶帳號接上 ⇒ phone_taken,不帶任何會員資料(F06)
-- =========================================================================
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c4');
insert into c2p_out values ('taken', public.customer_complete_profile('pgtap-c2p-m', '0912-170-142', '我', true)::text);
insert into c2p_out values ('taken_session', public.get_customer_session_state('pgtap-c2p-m')::text);
select pg_temp.as_postgres();
select is((select body from c2p_out where label = 'taken'), '{"state": "phone_taken"}', 'F06-1 phone_taken 回應原文只有 state');
select is((select user_id from members where id = 'c2b00000-0000-4000-8000-000000000042'), 'c2b00000-0000-4000-8000-0000000000d1'::uuid,
          'C03-12 已被別人接上的會員不被取代');
select is((select body::jsonb ->> 'state' from c2p_out where label = 'taken_session'), 'needs_profile', 'C03-13 phone_taken 後客人仍是 needs_profile');
select is((select array_agg(label) from c2p_out where body ~ 'SENTINEL_(EXISTING|TAKEN|PROBE)|c2b00000-0000-4000-8000-0000000000d1|1990-01-02'),
          null, 'F06-2 所有客戶端回應都搜不到別的會員的姓名 / 帳號 / 生日');

-- =========================================================================
-- Q6:24 小時最多 5 支不同電話
-- =========================================================================
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c5');
select is((select array_agg(public.customer_complete_profile('pgtap-c2p-m', '091217020' || i, '我', true) ->> 'state' order by i) from generate_series(1, 5) i),
          array['phone_taken', 'phone_taken', 'phone_taken', 'phone_taken', 'phone_taken'], 'F06-3 前 5 支照常判斷');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912170299', '我', true), '{"state": "too_many_attempts"}'::jsonb, 'F06-4 第 6 支不同電話 ⇒ too_many_attempts');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912-170-203', '我', true) ->> 'state', 'phone_taken', 'F06-5 重送試過的電話不算新的一支');
select pg_temp.as_postgres();
select is((select count(*)::int from members where user_id = 'c2b00000-0000-4000-8000-0000000000c5'), 0, 'F06-6 被限制時沒有建出任何會員');
update customer_policy_consents set consented_at = now() - interval '25 hours' where user_id = 'c2b00000-0000-4000-8000-0000000000c5';
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c5');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912170299', '我', true), '{"state": "linked", "created": true}'::jsonb, 'F06-7 超過 24 小時就重新計算');

-- =========================================================================
-- 商家停用 LINE 登入
-- =========================================================================
select pg_temp.as_postgres();
update merchant_line_login_configs set enabled = false where merchant_id = 'c2b00000-0000-4000-8000-000000000022';
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c3');
select is(public.customer_complete_profile('pgtap-c2p-n', '0912170301', '我', true), '{"state": "line_login_unavailable"}'::jsonb, 'C03-14 停用 ⇒ line_login_unavailable');
select is(public.get_customer_session_state('pgtap-c2p-n'), '{"state": "line_login_unavailable"}'::jsonb, 'C05-7 停用 ⇒ session 也是 line_login_unavailable');

-- =========================================================================
-- C2-H03 會員詳細頁登入狀態
-- =========================================================================
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a2');
select is(public.get_member_customer_login_status('c2b00000-0000-4000-8000-000000000041') ->> 'linked', 'true', 'H03-1 有會員權限的客服看得到「已連結」');
select ok((public.get_member_customer_login_status('c2b00000-0000-4000-8000-000000000041')::text) !~ 'SENTINEL_LINE_SUB', 'H03-2 不回 LINE userId');
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a3');
select throws_ok($$select public.get_member_customer_login_status('c2b00000-0000-4000-8000-000000000041')$$, '42501', null, 'H03-3 沒有會員權限的客服被拒');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c2');
select throws_ok($$select public.get_member_customer_login_status('c2b00000-0000-4000-8000-000000000041')$$, '42501', null, 'H03-4 客人自己不能用後台函式');

-- =========================================================================
-- C2-H02 解除綁定 ⇒ 客戶端登入一起斷開
-- =========================================================================
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a1');
select lives_ok($$select public.unbind_line_account('member', 'c2b00000-0000-4000-8000-000000000041')$$, 'H02-1 管理員解除會員 LINE 綁定');
select pg_temp.as_postgres();
select is((select coalesce(user_id::text, 'null') || '/' || coalesce(line_user_id, 'null') || '/' || line_bound || '/' || (identity_first_verified_at is not null)
           from members where id = 'c2b00000-0000-4000-8000-000000000041'),
          'null/null/false/true', 'H02-2 user_id、LINE 清掉;第一次驗證時間保留');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c2');
select is(public.get_customer_session_state('pgtap-c2p-m') ->> 'state', 'needs_profile', 'H02-3 那位客人再進來要重新填電話');

-- =========================================================================
-- 主腦複查:解除後,被解除的帳號不能自動接回;別的帳號可以;店家可以撤銷
-- =========================================================================
insert into c2p_out values ('blocked', public.customer_complete_profile('pgtap-c2p-m', '0912170141', '我', true)::text);
select pg_temp.as_postgres();
select is((select body from c2p_out where label = 'blocked'), '{"state": "phone_taken"}', 'RB-1 被解除的帳號再填同一支電話 ⇒ phone_taken(回應原文只有 state)');
select is((select user_id from members where id = 'c2b00000-0000-4000-8000-000000000041'), null, 'RB-2 會員沒有被接回去');
select is((select count(*)::int from customer_member_link_blocks where member_id = 'c2b00000-0000-4000-8000-000000000041'
           and user_id = 'c2b00000-0000-4000-8000-0000000000c2'), 1, 'RB-3 封鎖紀錄存在');
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a2');
select is(public.get_member_customer_login_status('c2b00000-0000-4000-8000-000000000041'),
          '{"linked": false, "last_login_at": null, "relink_blocked": true}'::jsonb, 'RB-4 後台看得到「有帳號被擋住」');
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a3');
select throws_ok($$select public.allow_member_customer_relink('c2b00000-0000-4000-8000-000000000041')$$, '42501', null, 'RB-5 沒有會員權限的客服不能撤銷');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c2');
select throws_ok($$select public.allow_member_customer_relink('c2b00000-0000-4000-8000-000000000041')$$, '42501', null, 'RB-6 客人自己不能撤銷');
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a2');
select is(public.allow_member_customer_relink('c2b00000-0000-4000-8000-000000000041'), 1, 'RB-7 有會員權限的客服可以「允許重新接上」');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c2');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912170141', '我', true), '{"state": "linked", "existing": true}'::jsonb, 'RB-8 撤銷後同一個帳號可以再接上');
-- 再解除一次 ⇒ c2 又被擋;換別的 LINE 帳號(c4)填同一支電話 ⇒ 照常接上
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a1');
select public.unbind_line_account('member', 'c2b00000-0000-4000-8000-000000000041');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c2');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912170141', '我', true) ->> 'state', 'phone_taken', 'RB-9 再解除一次又被擋');
select pg_temp.as_postgres();
select throws_ok($$select private.link_customer_to_member('c2b00000-0000-4000-8000-000000000041', 'c2b00000-0000-4000-8000-0000000000c2', 'x')$$,
                 '42501', '這位會員目前不能自動接上，請聯繫店家。', 'RB-12 內部接上函式也擋被封鎖的帳號(最後一道防線)');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c4');
select is(public.customer_complete_profile('pgtap-c2p-m', '0912170141', '我', true), '{"state": "linked", "existing": true}'::jsonb, 'RB-10 別的 LINE 帳號照常直接接上');
select pg_temp.as_postgres();
select is((select user_id from members where id = 'c2b00000-0000-4000-8000-000000000041'), 'c2b00000-0000-4000-8000-0000000000c4'::uuid, 'RB-11 會員接到新的帳號');
select pg_temp.as_customer('c2b00000-0000-4000-8000-0000000000c2');

-- =========================================================================
-- C2-H01 客戶帳號不能建店
-- =========================================================================
select throws_ok($$select public.create_group_and_merchant('客人想開店', 'in_store_beauty')$$, '42501', '客人帳號不能建立商家。', 'H01-1 客戶帳號不能建集團+店');
select throws_ok($$select public.create_merchant_in_group('c2b00000-0000-4000-8000-000000000011', '客人想開分店', 'in_store_beauty')$$, '42501', '客人帳號不能建立商家。', 'H01-2 客戶帳號不能建分店');
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a4');
select lives_ok($$select public.create_group_and_merchant('一般使用者開店', 'in_store_beauty')$$, 'H01-3 一般使用者仍可以建店');
select pg_temp.as_user('c2b00000-0000-4000-8000-0000000000a1');
select lives_ok($$select public.create_merchant_in_group('c2b00000-0000-4000-8000-000000000011', '管理員開分店', 'in_store_beauty')$$, 'H01-4 管理員仍可以建分店');

-- =========================================================================
-- 標記不外洩:呼叫完之後 can_manage_members 對客人仍是 false
-- =========================================================================
select pg_temp.as_postgres();
select is(coalesce(current_setting('miaoyue.customer_member_create', true), ''), '', 'MK-1 建會員後交易內標記已清空');

select * from finish();
rollback;
