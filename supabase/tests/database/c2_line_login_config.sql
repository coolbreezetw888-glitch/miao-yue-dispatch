-- 客戶端第 2 批 — C2-A01~A04 商家 LINE 登入設定、C2-C01 公開頁新欄位、C2-F01 secret 只進不出
-- 規格書 .project/specs/客戶端第2批-LINE登入與訪客預約.md(零之二優先)
begin;

select plan(34);

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
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
grant execute on function pg_temp.as_user(uuid, text, text) to anon, authenticated;
grant execute on function pg_temp.as_postgres() to anon, authenticated;

-- Fixture
insert into auth.users (id, email) values
  ('c2a00000-0000-4000-8000-000000000001', 'pgtap-c2cfg-admin@test.local'),
  ('c2a00000-0000-4000-8000-000000000002', 'pgtap-c2cfg-agent@test.local'),
  ('c2a00000-0000-4000-8000-000000000003', 'pgtap-c2cfg-other-admin@test.local'),
  ('c2a00000-0000-4000-8000-000000000004', 'pgtap-c2cfg-platform@test.local');
insert into auth.users (id, email, raw_app_meta_data) values
  ('c2a00000-0000-4000-8000-000000000005', 'line-pgtap-c2cfg@customer.miaoyue.invalid', '{"account_type":"customer"}');
insert into groups (id) values ('c2a00000-0000-4000-8000-000000000011'), ('c2a00000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c2a00000-0000-4000-8000-000000000021', 'c2a00000-0000-4000-8000-000000000011', 'C2 設定測試店', 'in_store_beauty', 'pgtap-c2cfg-ok', 'active'),
  ('c2a00000-0000-4000-8000-000000000022', 'c2a00000-0000-4000-8000-000000000012', 'C2 別家', 'in_store_beauty', 'pgtap-c2cfg-other', 'active');
insert into merchant_admins (merchant_id, user_id) values
  ('c2a00000-0000-4000-8000-000000000021', 'c2a00000-0000-4000-8000-000000000001'),
  ('c2a00000-0000-4000-8000-000000000022', 'c2a00000-0000-4000-8000-000000000003');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c2a00000-0000-4000-8000-000000000031', 'c2a00000-0000-4000-8000-000000000021', 'c2a00000-0000-4000-8000-000000000002',
   '客服', 'pgtap-c2cfg-agent@test.local', 'active', now(), '0900170031');
insert into merchant_agent_permissions (agent_id, section_key, granted)
select 'c2a00000-0000-4000-8000-000000000031', k, true from unnest(array['members', 'orders', 'settings']) k;
insert into platform_admins (user_id) values ('c2a00000-0000-4000-8000-000000000004');

create temp table c2cfg_out (label text, body text);
grant all on c2cfg_out to anon, authenticated;

-- =========================================================================
-- C2-A01 表層權限 + check
-- =========================================================================
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001');
select throws_ok($$select * from merchant_line_login_configs$$, '42501', null, 'A01-1 authenticated 直接 select 設定表被拒');
select throws_ok($$insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4)
                   values ('c2a00000-0000-4000-8000-000000000021', '1234567890', gen_random_uuid(), 'abcd')$$,
                 '42501', null, 'A01-2 authenticated 直接 insert 被拒');
select throws_ok($$update merchant_line_login_configs set enabled = true$$, '42501', null, 'A01-3 authenticated 直接 update 被拒');
select throws_ok($$delete from merchant_line_login_configs$$, '42501', null, 'A01-4 authenticated 直接 delete 被拒');
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001', 'anon');
select throws_ok($$select * from merchant_line_login_configs$$, '42501', null, 'A01-5 anon 直接 select 被拒');
select pg_temp.as_postgres();

select throws_ok($$insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4)
                   values ('c2a00000-0000-4000-8000-000000000022', '123456789', gen_random_uuid(), 'abcd')$$,
                 '23514', null, 'A01-6 Channel ID 9 碼被 check 擋下');
select throws_ok($$insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4)
                   values ('c2a00000-0000-4000-8000-000000000022', '12345678901', gen_random_uuid(), 'abcd')$$,
                 '23514', null, 'A01-7 Channel ID 11 碼被 check 擋下');
select throws_ok($$insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, linked_oa_status)
                   values ('c2a00000-0000-4000-8000-000000000022', '1234567890', gen_random_uuid(), 'abcd', 'yes')$$,
                 '23514', null, 'A01-8 linked_oa_status 不在清單被擋下');

-- =========================================================================
-- C2-A02 權限
-- =========================================================================
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000002');
select throws_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', '1234567890', 'SENTINELSECRET0123456789abcdef01')$$,
                 '42501', '只有商家管理員或平台管理員可以設定 LINE 登入。', 'A02-1 客服(就算有設定權限)被拒');
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000003');
select throws_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', '1234567890', 'SENTINELSECRET0123456789abcdef01')$$,
                 '42501', null, 'A02-2 別家管理員被拒');
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000005', 'authenticated', 'customer');
select throws_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', '1234567890', 'SENTINELSECRET0123456789abcdef01')$$,
                 '42501', null, 'A02-3 客戶帳號被拒');
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001', 'anon');
select throws_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', '1234567890', 'SENTINELSECRET0123456789abcdef01')$$,
                 '42501', null, 'A02-4 未登入沒有執行權限');

-- 格式錯誤:錯誤訊息不能帶出傳入的 secret
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', '1234567890', 'SENTINELBADSECRET-with-dash!!')$$,
                 '22023', 'Channel Secret 格式不正確，應該是 32 碼英文與數字，請到 LINE Developers 重新複製。',
                 'A02-5 secret 格式錯 ⇒ 固定句子(不含傳入值)');
select throws_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', '1234567890', '')$$,
                 '22023', '第一次設定時，請填寫 Channel Secret。', 'A02-6 第一次設定 secret 必填');
select throws_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', 'abc', 'SENTINELSECRET0123456789abcdef01')$$,
                 '22023', null, 'A02-7 Channel ID 格式錯');

select lives_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', ' 1234567890 ', 'SENTINELSECRET0123456789abcdef01')$$,
                'A02-8 管理員可以設定');
select pg_temp.as_postgres();

select is((select decrypted_secret from vault.decrypted_secrets s join merchant_line_login_configs c on c.channel_secret_vault_id = s.id
           where c.merchant_id = 'c2a00000-0000-4000-8000-000000000021'),
          'SENTINELSECRET0123456789abcdef01', 'A02-9 Vault 裡是正確的 secret');
select is((select count(*)::int from merchant_line_login_configs c where c::text like '%SENTINELSECRET%'), 0,
          'A02-10 設定表整列轉文字搜不到 secret 原文');
select is((select channel_id || '/' || channel_secret_last4 || '/' || enabled from merchant_line_login_configs where merchant_id = 'c2a00000-0000-4000-8000-000000000021'),
          '1234567890/ef01/false', 'A02-11 Channel ID 去空白、末 4 碼、預設未啟用');

-- 只改 Channel ID ⇒ secret 不變;last_login 清掉
update merchant_line_login_configs set last_login_succeeded_at = now(), linked_oa_status = 'ok' where merchant_id = 'c2a00000-0000-4000-8000-000000000021';
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000004');   -- 平台管理員
select lives_ok($$select public.set_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021', '1234567891', null)$$,
                'A02-12 平台管理員可以設定;secret 空白只改 Channel ID');
select pg_temp.as_postgres();
select is((select decrypted_secret || '/' || c.channel_id || '/' || coalesce(c.last_login_succeeded_at::text, 'null') || '/' || coalesce(c.linked_oa_status, 'null')
           from vault.decrypted_secrets s join merchant_line_login_configs c on c.channel_secret_vault_id = s.id
           where c.merchant_id = 'c2a00000-0000-4000-8000-000000000021'),
          'SENTINELSECRET0123456789abcdef01/1234567891/null/null', 'A02-13 secret 沿用、Channel ID 換新、驗證狀態清空');

-- =========================================================================
-- C2-A03 / A04
-- =========================================================================
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_merchant_line_login_enabled('c2a00000-0000-4000-8000-000000000022', true)$$,
                 '42501', null, 'A04-1 別家的店不能開關');
select lives_ok($$select public.set_merchant_line_login_enabled('c2a00000-0000-4000-8000-000000000021', true)$$, 'A04-2 有設定可以啟用');
insert into c2cfg_out values ('status', public.get_merchant_line_login_status('c2a00000-0000-4000-8000-000000000021')::text);
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000003');
select throws_ok($$select public.set_merchant_line_login_enabled('c2a00000-0000-4000-8000-000000000022', true)$$,
                 'P0002', '請先儲存 LINE 登入設定(Channel ID 與 Channel Secret)，才能啟用。', 'A04-3 沒有設定不能啟用');
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000002');
select throws_ok($$select public.get_merchant_line_login_status('c2a00000-0000-4000-8000-000000000021')$$, '42501', null, 'A03-1 客服不能看設定');
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001', 'anon');
insert into c2cfg_out values ('page', public.get_public_booking_page('pgtap-c2cfg-ok')::text);
select pg_temp.as_postgres();

select is((select (body::jsonb) - 'last_login_succeeded_at' from c2cfg_out where label = 'status'),
          '{"enabled": true, "channel_id": "1234567891", "configured": true, "callback_path": "/auth/line/callback", "linked_oa_status": null, "channel_secret_masked": "••••ef01"}'::jsonb,
          'A03-2 狀態只回白名單欄位(遮罩 secret)');
select is((select body::jsonb -> 'booking_settings' ->> 'line_login_enabled' from c2cfg_out where label = 'page'), 'true',
          'C01-1 公開頁 line_login_enabled = true');
select is((select array_agg(label order by label) from c2cfg_out
           where strpos(body, 'SENTINELSECRET') > 0
              or strpos(body, (select channel_secret_vault_id::text from merchant_line_login_configs where merchant_id = 'c2a00000-0000-4000-8000-000000000021')) > 0),
          null, 'F01-1 狀態函式、公開頁回應原文都搜不到 secret 與 Vault id');
select ok((select strpos(body, '1234567891') = 0 from c2cfg_out where label = 'page'), 'C01-2 公開頁不回 Channel ID');

insert into merchant_member_settings (merchant_id, policy_enabled, policy_content)
values ('c2a00000-0000-4000-8000-000000000021', true, '本店會員政策')
on conflict (merchant_id) do update set policy_enabled = true, policy_content = '本店會員政策';
select is(public.get_public_booking_page('pgtap-c2cfg-ok') -> 'booking_settings' ->> 'member_policy', '本店會員政策', 'C01-3 會員政策開啟 ⇒ 回內容');
update merchant_member_settings set policy_content = '   ' where merchant_id = 'c2a00000-0000-4000-8000-000000000021';
select is(public.get_public_booking_page('pgtap-c2cfg-ok') -> 'booking_settings' -> 'member_policy', 'null'::jsonb, 'C01-4 會員政策開啟但內容空白 ⇒ null');

-- 停用 ⇒ 公開頁 false;刪除 ⇒ Vault 一起刪
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001');
select public.set_merchant_line_login_enabled('c2a00000-0000-4000-8000-000000000021', false);
select pg_temp.as_postgres();
select is(public.get_public_booking_page('pgtap-c2cfg-ok') -> 'booking_settings' ->> 'line_login_enabled', 'false', 'A04-4 停用 ⇒ 公開頁 false');

create temp table c2cfg_vault as select channel_secret_vault_id as id from merchant_line_login_configs where merchant_id = 'c2a00000-0000-4000-8000-000000000021';
select pg_temp.as_user('c2a00000-0000-4000-8000-000000000001');
select lives_ok($$select public.delete_merchant_line_login_config('c2a00000-0000-4000-8000-000000000021')$$, 'A04-5 管理員可以刪除設定');
select pg_temp.as_postgres();
select is((select count(*)::int from vault.secrets where id = (select id from c2cfg_vault))
          + (select count(*)::int from merchant_line_login_configs where merchant_id = 'c2a00000-0000-4000-8000-000000000021'),
          0, 'A04-6 刪除設定 ⇒ 設定列與 Vault secret 都不見');

select * from finish();
rollback;
