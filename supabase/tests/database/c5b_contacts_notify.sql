-- 客戶端第 5-B 批 — 聯絡人通知(C5-S03、N09~N11)
-- 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md(零之零;N11 ⚠️範圍)
--
--   S03  member_contact_request_create / resolve_contact_request(同意 / 拒絕)/ customer_remove_contact /
--        merchant_remove_member_contact 成功後寫待發列;自己退出、早就是聯絡人、店沒接上、「聯絡人通知」關掉 ⇒ 不寫
--   R01  聯絡人事件收件人:N09 主要聯絡人、N10 被移除的人(看他被移除前那列的開關)、N11 申請人;關開關 / 非好友 / 沒身分
--   S05  prepare:範本代碼、變數(contact_name、member_name)、申請已處理 ⇒ stale、超過 6 小時 ⇒ stale
--   X    新函式 proacl;客人函式回應不含 LINE userId
begin;

select plan(40);

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
grant execute on function pg_temp.as_customer(uuid) to anon, authenticated, service_role;
grant execute on function pg_temp.as_user(uuid) to anon, authenticated, service_role;
grant execute on function pg_temp.as_postgres() to anon, authenticated, service_role;

create function pg_temp.u(p text) returns uuid language sql as $$ select ('c5d00000-0000-4000-8000-0000000000' || p)::uuid $$;
grant execute on function pg_temp.u(text) to anon, authenticated, service_role;

-- 某位會員的聯絡人待發列(種類:對象尾碼:payload 摘要)
create function pg_temp.obs(p_member text)
returns text[] language sql as $$
  select coalesce(array_agg(kind || ':' || right(subject_user_id::text, 2)
                            || coalesce(':' || (payload ->> 'approved'), '') || coalesce(':' || (payload ->> 'removed_via'), '')
                            order by created_at, kind, subject_user_id), array[]::text[])
  from public.customer_line_outbox where member_id = pg_temp.u(p_member) and booking_id is null
$$;

-- 領取(processing)後準備
create function pg_temp.prep(p_kind text, p_member text, p_subject text)
returns jsonb language plpgsql as $$
declare v uuid;
begin
  select id into v from public.customer_line_outbox
  where kind = p_kind and member_id = pg_temp.u(p_member) and subject_user_id = pg_temp.u(p_subject)
  order by created_at desc limit 1;
  update public.customer_line_outbox set status = 'processing', claimed_at = now() where id = v and status = 'pending';
  return public.internal_prepare_customer_line_job(v);
end $$;

create function pg_temp.rc(j jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(x order by x), array[]::text[]) from (
    select 'to:' || right(e ->> 'target_user_id', 2) x from jsonb_array_elements(j -> 'recipients') e
    union all
    select 'skip:' || coalesce(right(e ->> 'target_user_id', 2), '-') || ':' || (e ->> 'reason') from jsonb_array_elements(j -> 'skipped') e
  ) t
$$;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c5d00000-0000-4000-8000-000000000001', 'pgtap-c5d-admin@test.local', '{}'::jsonb);
insert into auth.users (id, email, raw_app_meta_data)
select pg_temp.u(s), 'line-pgtap-c5d-' || s || '@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb
from unnest(array['11','12','13','14','15','16']) s;

insert into groups (id) values ('c5d00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status, phone) values
  ('c5d00000-0000-4000-8000-000000000031', 'c5d00000-0000-4000-8000-000000000091', 'C5D聯絡人店', 'in_store_beauty', 'pgtap-c5d-a', 'active', '0223456789'),
  ('c5d00000-0000-4000-8000-000000000032', 'c5d00000-0000-4000-8000-000000000091', 'C5D沒接店', 'in_store_beauty', 'pgtap-c5d-b', 'active', null);
insert into merchant_admins (merchant_id, user_id) values
  ('c5d00000-0000-4000-8000-000000000031', 'c5d00000-0000-4000-8000-000000000001'),
  ('c5d00000-0000-4000-8000-000000000032', 'c5d00000-0000-4000-8000-000000000001');
insert into merchant_line_configs (merchant_id, channel_id, channel_secret_vault_id, channel_access_token_vault_id, channel_secret_last4, channel_access_token_last4, is_connected) values
  ('c5d00000-0000-4000-8000-000000000031', '1234567811', vault.create_secret('C5D-A-SECRET'), vault.create_secret('C5D-A-TOKEN-SENTINEL'), right('C5D-A-SECRET', 4), right('C5D-A-TOKEN-SENTINEL', 4), true),
  ('c5d00000-0000-4000-8000-000000000032', '1234567812', vault.create_secret('C5D-B-SECRET'), vault.create_secret('C5D-B-TOKEN-SENTINEL'), right('C5D-B-SECRET', 4), right('C5D-B-TOKEN-SENTINEL', 4), false);
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c5d00000-0000-4000-8000-000000000031', '5656565656', vault.create_secret('C5DFAKESECRET00000000000000000AA'), '00AA', true),
  ('c5d00000-0000-4000-8000-000000000032', '5757575757', vault.create_secret('C5DFAKESECRET00000000000000000BB'), '00BB', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name)
select pg_temp.u(s), '5656565656', 'U00000000000000000000000000c5d0' || s, case s when '13' then E'申請\n人' else 'LINE' || s end
from unnest(array['11','12','13','14','15']) s;
-- 16 是 B 店 channel 的身分
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name)
values (pg_temp.u('16'), '5757575757', 'U00000000000000000000000000c5d016', 'LINE16');

insert into members (id, merchant_id, name, phone, referral_code) values
  (pg_temp.u('41'), 'c5d00000-0000-4000-8000-000000000031', '王公司', '0912540001', 'C5DREF41'),
  (pg_temp.u('42'), 'c5d00000-0000-4000-8000-000000000032', 'B店會員', '0912540002', 'C5DREF42');
-- 41:主要 11、第二聯絡人 12
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via) values
  (pg_temp.u('71'), 'c5d00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('11'), true, 'backfill'),
  (pg_temp.u('72'), 'c5d00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('12'), false, 'invite'),
  (pg_temp.u('73'), 'c5d00000-0000-4000-8000-000000000032', pg_temp.u('42'), pg_temp.u('16'), true, 'backfill');
select private.member_sync_primary(pg_temp.u('41'));

-- =========================================================================
-- N09 申請 ⇒ 通知主要聯絡人
-- =========================================================================
select is(private.member_contact_request_create(pg_temp.u('41'), pg_temp.u('13'), '0912540013'), 'join_pending', 'N09-1 申請照常成立');
select is(pg_temp.obs('41'), array['customer_contact_request:13'], 'N09-2 寫一筆「聯絡人申請」待發列(對象 = 申請人,沒有訂單)');
select is((select dedupe_key from customer_line_outbox where kind = 'customer_contact_request' and member_id = pg_temp.u('41')),
          'contact_request:' || pg_temp.u('41') || ':' || pg_temp.u('13'), 'N09-3 dedupe_key = contact_request:會員:申請人');
select is(private.member_contact_request_create(pg_temp.u('41'), pg_temp.u('13'), '0912540013'), 'join_pending', 'N09-4 同一個申請再送一次');
select is(pg_temp.obs('41'), array['customer_contact_request:13'], 'N09-5 ⇒ 不會多一筆');
select pg_temp.prep('customer_contact_request', '41', '13') as j \gset q_
select is(array[:'q_j'::jsonb ->> 'state', :'q_j'::jsonb ->> 'template_code', :'q_j'::jsonb ->> 'log_event_type'],
          array['send', 'contact_request', 'customer_contact_request'], 'N09-6 prepare:範本 contact_request');
select is(pg_temp.rc(:'q_j'::jsonb), array['to:11'], 'N09-7 收件人 = 主要聯絡人(不是第二聯絡人、不是申請人)');
select is(array[:'q_j'::jsonb -> 'variables' ->> 'contact_name', :'q_j'::jsonb -> 'variables' ->> 'merchant_name',
                :'q_j'::jsonb -> 'variables' ->> 'merchant_phone', :'q_j'::jsonb -> 'variables' ->> 'booking_date'],
          array[E'申請\n人', 'C5D聯絡人店', '0223456789', ''], 'N09-8 變數:contact_name = 申請人 LINE 顯示名(換行由 Edge 處理)、沒有預約類資料');
select ok(:'q_j'::jsonb ->> 'template' like '{{contact_name}} 申請成為您在「{{merchant_name}}」會員的聯絡人%', 'N09-9 預設範本');
update customer_line_outbox set status = 'processing' where kind = 'customer_contact_request' and member_id = pg_temp.u('41');
update member_customer_contacts set notify_booking = false where id = pg_temp.u('71');
select is(pg_temp.rc(public.internal_prepare_customer_line_job((select id from customer_line_outbox where kind = 'customer_contact_request' and member_id = pg_temp.u('41')))),
          array['skip:11:customer_opted_out'], 'N09-10 主要聯絡人關掉「預約通知」⇒ customer_opted_out(開關一律看預約通知 ⚠️)');
update member_customer_contacts set notify_booking = true where id = pg_temp.u('71');
insert into customer_line_friendships (merchant_id, line_user_id, is_friend, source, changed_at)
values ('c5d00000-0000-4000-8000-000000000031', 'U00000000000000000000000000c5d011', false, 'webhook', now());
select is(pg_temp.rc(public.internal_prepare_customer_line_job((select id from customer_line_outbox where kind = 'customer_contact_request' and member_id = pg_temp.u('41')))),
          array['skip:11:not_friend'], 'N09-11 主要聯絡人已知沒加好友 ⇒ not_friend');
delete from customer_line_friendships where merchant_id = 'c5d00000-0000-4000-8000-000000000031';
update customer_line_outbox set created_at = now() - interval '6 hours 1 minute' where kind = 'customer_contact_request' and member_id = pg_temp.u('41');
select is(public.internal_prepare_customer_line_job((select id from customer_line_outbox where kind = 'customer_contact_request' and member_id = pg_temp.u('41'))) ->> 'state',
          'stale', 'N09-12 超過 6 小時還沒發 ⇒ stale');
update customer_line_outbox set created_at = now() where kind = 'customer_contact_request' and member_id = pg_temp.u('41');

-- =========================================================================
-- N11 申請結果 ⇒ 通知申請人
-- =========================================================================
select is(private.resolve_contact_request((select id from member_contact_requests where user_id = pg_temp.u('13')), pg_temp.u('41'), true, pg_temp.u('11'), 'customer') ->> 'state',
          'approved', 'N11-1 主要聯絡人同意');
select is(pg_temp.obs('41'), array['customer_contact_request:13', 'customer_contact_request_resolved:13:true'], 'N11-2 寫一筆「申請結果:同意」');
select is(public.internal_prepare_customer_line_job((select id from customer_line_outbox where kind = 'customer_contact_request' and member_id = pg_temp.u('41'))) ->> 'state',
          'stale', 'N09-13 申請在發送前已被處理 ⇒ 「有人申請」那則過時不發');
select pg_temp.prep('customer_contact_request_resolved', '41', '13') as j \gset a_
select is(array[:'a_j'::jsonb ->> 'state', :'a_j'::jsonb ->> 'template_code', :'a_j'::jsonb -> 'variables' ->> 'member_name'],
          array['send', 'contact_approved', '王公司'], 'N11-3 prepare:範本 contact_approved、member_name');
select is(pg_temp.rc(:'a_j'::jsonb), array['to:13'], 'N11-4 收件人 = 申請人');

select is(private.member_contact_request_create(pg_temp.u('41'), pg_temp.u('14'), '0912540014'), 'join_pending', 'N11-5 另一人申請');
select is(private.resolve_contact_request((select id from member_contact_requests where user_id = pg_temp.u('14')), null, false, 'c5d00000-0000-4000-8000-000000000001'::uuid, 'store') ->> 'state',
          'rejected', 'N11-6 店家拒絕');
select pg_temp.prep('customer_contact_request_resolved', '41', '14') as j \gset r_
select is(array[:'r_j'::jsonb ->> 'template_code', :'r_j'::jsonb ->> 'state'], array['contact_rejected', 'send'], 'N11-7 範本 contact_rejected');
select is(pg_temp.rc(:'r_j'::jsonb), array['to:14'], 'N11-8 被拒絕的人沒有聯絡人列 ⇒ 視為開著,照發');

-- 早就是聯絡人(同意時 v_existing = 這位會員)⇒ 不發
insert into member_contact_requests (merchant_id, member_id, user_id, phone_normalized)
values ('c5d00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('12'), '0912540012');
select is(private.resolve_contact_request((select id from member_contact_requests where user_id = pg_temp.u('12')), pg_temp.u('41'), true, pg_temp.u('11'), 'customer') ->> 'state',
          'approved', 'N11-9 早就是這位會員的聯絡人 ⇒ approved');
select is((select count(*)::int from customer_line_outbox where kind = 'customer_contact_request_resolved' and subject_user_id = pg_temp.u('12')),
          0, 'N11-10 ⇒ 不發「申請結果」');

-- =========================================================================
-- N10 被移除 ⇒ 通知被移除的人
-- =========================================================================
select pg_temp.as_customer(pg_temp.u('11'));
select is(public.customer_remove_contact('pgtap-c5d-a', pg_temp.u('72')), '{"state": "ok"}'::jsonb, 'N10-1 主要聯絡人移除第二聯絡人');
select pg_temp.as_postgres();
select ok((select payload ->> 'removed_via' = 'primary' and payload ->> 'contact_id' = pg_temp.u('72')::text
           from customer_line_outbox where kind = 'customer_contact_removed' and subject_user_id = pg_temp.u('12')),
          'N10-2 寫一筆「已被移除」(對象 12、記被移除前那列)');
update member_customer_contacts set notify_booking = false where id = pg_temp.u('72');
select pg_temp.prep('customer_contact_removed', '41', '12') as j \gset m_
select is(pg_temp.rc(:'m_j'::jsonb), array['skip:12:customer_opted_out'], 'N10-3 開關看被移除前那列(關著 ⇒ 不發)');
update member_customer_contacts set notify_booking = true where id = pg_temp.u('72');
select is(pg_temp.rc(public.internal_prepare_customer_line_job((select id from customer_line_outbox where kind = 'customer_contact_removed' and subject_user_id = pg_temp.u('12')))),
          array['to:12'], 'N10-4 開著 ⇒ 發給被移除的人');
select is(:'m_j'::jsonb ->> 'template_code', 'contact_removed', 'N10-5 範本 contact_removed');

select id as c13 from member_customer_contacts where user_id = pg_temp.u('13') and status = 'active' \gset
select pg_temp.as_user('c5d00000-0000-4000-8000-000000000001');
select is(public.merchant_remove_member_contact(:'c13'::uuid) ->> 'state',
          'ok', 'N10-6 店家移除第二聯絡人');
select pg_temp.as_postgres();
select is((select payload ->> 'removed_via' from customer_line_outbox where kind = 'customer_contact_removed' and subject_user_id = pg_temp.u('13')),
          'store', 'N10-7 ⇒ 寫一筆「已被移除」(store)');

-- 自己退出不發
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via) values
  (pg_temp.u('74'), 'c5d00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('15'), false, 'invite');
select pg_temp.as_customer(pg_temp.u('15'));
select is(public.customer_leave_member('pgtap-c5d-a') ->> 'state', 'ok', 'N10-8 第二聯絡人自己退出');
select pg_temp.as_postgres();
select is((select count(*)::int from customer_line_outbox where kind = 'customer_contact_removed' and subject_user_id = pg_temp.u('15')),
          0, 'N10-9 自己退出 ⇒ 不發 ⚠️');

-- 店家主要聯絡人移除(換新主要)也通知
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via) values
  (pg_temp.u('75'), 'c5d00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('14'), false, 'invite');
select pg_temp.as_user('c5d00000-0000-4000-8000-000000000001');
select is(public.merchant_remove_member_contact(pg_temp.u('71'), pg_temp.u('75')) ->> 'state', 'ok', 'N10-10 店家移除主要聯絡人並指定新主要');
select pg_temp.as_postgres();
select is((select count(*)::int from customer_line_outbox where kind = 'customer_contact_removed' and subject_user_id = pg_temp.u('11')),
          1, 'N10-11 ⇒ 原主要聯絡人收到「已被移除」');

-- =========================================================================
-- 不寫的情況
-- =========================================================================
select is(private.member_contact_request_create(pg_temp.u('42'), pg_temp.u('16'), '0912540016'), 'join_pending', 'S03-1 沒接上官方帳號的店:申請照常');
select is(pg_temp.obs('42'), array[]::text[], 'S03-2 ⇒ 不寫待發列');
insert into merchant_customer_line_settings (merchant_id, on_contact_events) values ('c5d00000-0000-4000-8000-000000000031', false);
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via) values
  (pg_temp.u('76'), 'c5d00000-0000-4000-8000-000000000031', pg_temp.u('41'), pg_temp.u('15'), false, 'invite');
select pg_temp.as_customer(pg_temp.u('14'));
select is(public.customer_remove_contact('pgtap-c5d-a', pg_temp.u('76')), '{"state": "ok"}'::jsonb, 'S03-3 店家關掉「聯絡人通知」:移除照常');
select pg_temp.as_postgres();
select is((select count(*)::int from customer_line_outbox where kind = 'customer_contact_removed' and subject_user_id = pg_temp.u('15')),
          0, 'S03-4 ⇒ 不寫待發列');

-- =========================================================================
-- X
-- =========================================================================
select is((select count(*)::int from pg_proc p
           where p.oid in ('private.resolve_customer_line_contact_recipients(uuid)'::regprocedure, 'private.customer_line_contact_variables(uuid)'::regprocedure)
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))),
          0, 'X01-1 聯絡人收件人 / 變數兩支 private 函式全部收回');
select is((select array_agg(p.proname || ':' || has_function_privilege('anon', p.oid, 'execute') || ':' || has_function_privilege('authenticated', p.oid, 'execute')
                            order by p.proname)
           from pg_proc p where p.oid in ('public.customer_remove_contact(text, uuid)'::regprocedure, 'public.merchant_remove_member_contact(uuid, uuid)'::regprocedure,
                                          'private.member_contact_request_create(uuid, uuid, text)'::regprocedure,
                                          'private.resolve_contact_request(uuid, uuid, boolean, uuid, text)'::regprocedure)),
          array['customer_remove_contact:false:true', 'member_contact_request_create:false:false', 'merchant_remove_member_contact:false:true', 'resolve_contact_request:false:false'],
          'X01-2 改版後四支函式權限維持原樣');

select * from finish();
rollback;
