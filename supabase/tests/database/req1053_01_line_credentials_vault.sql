-- SPECS-INDEX #1053:各店 LINE Messaging API 金鑰搬進 Vault
-- 規格書 .project/specs/LINE金鑰搬Vault.md(R1~R4、R8)
-- migration 20261011000000_req1053_a_line_credentials_vault.sql / 20261011000100_req1053_b_drop_line_plaintext.sql
begin;

select plan(52);

create function pg_temp.as_user(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', p_role, 'app_metadata', '{}'::json)::text, true);
  execute format('set local role %I', p_role);
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
grant execute on function pg_temp.as_user(uuid, text) to anon, authenticated, service_role;
grant execute on function pg_temp.as_postgres() to anon, authenticated, service_role;

-- Fixture
insert into auth.users (id, email) values
  ('f1053000-0000-4000-8000-000000000001', 'pgtap-1053-admin-a@test.local'),
  ('f1053000-0000-4000-8000-000000000002', 'pgtap-1053-admin-b@test.local'),
  ('f1053000-0000-4000-8000-000000000003', 'pgtap-1053-admin-c@test.local');
insert into groups (id) values
  ('f1053000-0000-4000-8000-000000000011'), ('f1053000-0000-4000-8000-000000000012'), ('f1053000-0000-4000-8000-000000000013');
insert into merchants (id, group_id, name, industry_type, status) values
  ('f1053000-0000-4000-8000-000000000021', 'f1053000-0000-4000-8000-000000000011', '1053 A 店', 'in_store_beauty', 'active'),
  ('f1053000-0000-4000-8000-000000000022', 'f1053000-0000-4000-8000-000000000012', '1053 B 店', 'in_store_beauty', 'active'),
  ('f1053000-0000-4000-8000-000000000023', 'f1053000-0000-4000-8000-000000000013', '1053 C 店', 'in_store_beauty', 'active');
insert into merchant_admins (merchant_id, user_id) values
  ('f1053000-0000-4000-8000-000000000021', 'f1053000-0000-4000-8000-000000000001'),
  ('f1053000-0000-4000-8000-000000000022', 'f1053000-0000-4000-8000-000000000002'),
  ('f1053000-0000-4000-8000-000000000023', 'f1053000-0000-4000-8000-000000000003');

create temp table t1053 (label text primary key, v text);
grant all on t1053 to anon, authenticated, service_role;

-- =========================================================================
-- R1 欄位:4 個新欄位存在且 not null;明文欄位已移除
-- =========================================================================
select has_column('public', 'merchant_line_configs', 'channel_secret_vault_id', 'R1-1 有 channel_secret_vault_id');
select has_column('public', 'merchant_line_configs', 'channel_access_token_vault_id', 'R1-2 有 channel_access_token_vault_id');
select has_column('public', 'merchant_line_configs', 'channel_secret_last4', 'R1-3 有 channel_secret_last4');
select has_column('public', 'merchant_line_configs', 'channel_access_token_last4', 'R1-4 有 channel_access_token_last4');
select col_not_null('public', 'merchant_line_configs', 'channel_secret_vault_id', 'R1-5 channel_secret_vault_id not null');
select col_not_null('public', 'merchant_line_configs', 'channel_access_token_vault_id', 'R1-6 channel_access_token_vault_id not null');
select col_not_null('public', 'merchant_line_configs', 'channel_secret_last4', 'R1-7 channel_secret_last4 not null');
select col_not_null('public', 'merchant_line_configs', 'channel_access_token_last4', 'R1-8 channel_access_token_last4 not null');
select hasnt_column('public', 'merchant_line_configs', 'channel_secret', 'R6-B1 明文 channel_secret 欄位已移除');
select hasnt_column('public', 'merchant_line_configs', 'channel_access_token', 'R6-B2 明文 channel_access_token 欄位已移除');

-- =========================================================================
-- 表層權限:anon / authenticated 沒有任何表 / 欄位權限;沒有 RLS policy
-- =========================================================================
select ok(not has_table_privilege('anon', 'public.merchant_line_configs', 'select, insert, update, delete, truncate, references, trigger'),
  'P-1 anon 對 merchant_line_configs 沒有任何表權限');
select ok(not has_table_privilege('authenticated', 'public.merchant_line_configs', 'select, insert, update, delete, truncate, references, trigger'),
  'P-2 authenticated 對 merchant_line_configs 沒有任何表權限');
select is((select count(*)::int from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'merchant_line_configs' and grantee in ('anon', 'authenticated')),
  0, 'P-3 anon / authenticated 沒有任何欄位權限');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'merchant_line_configs'),
  0, 'P-4 merchant_line_configs 仍然沒有任何 RLS policy');

-- =========================================================================
-- R4 函式權限:internal 只給 service_role;private 輔助誰都不能直接呼叫
-- =========================================================================
select ok(not has_function_privilege('anon', 'public.internal_get_line_messaging_credentials(uuid)', 'execute'), 'F-1 anon 不能執行 internal_get_line_messaging_credentials');
select ok(not has_function_privilege('authenticated', 'public.internal_get_line_messaging_credentials(uuid)', 'execute'), 'F-2 authenticated 不能執行 internal_get_line_messaging_credentials');
select ok(has_function_privilege('service_role', 'public.internal_get_line_messaging_credentials(uuid)', 'execute'), 'F-3 service_role 可以執行 internal_get_line_messaging_credentials');
select is((select array_to_string(proacl, ',') from pg_proc where oid = 'public.internal_get_line_messaging_credentials(uuid)'::regprocedure),
  'postgres=X/postgres,service_role=X/postgres', 'F-4 internal_get_line_messaging_credentials 的 ACL 只有 postgres + service_role');
select is((select count(*)::int from unnest(array[
            'private.line_messaging_vault_upsert(uuid,text,text,text)',
            'private.line_messaging_access_token(uuid)',
            'private.merchant_line_configs_cleanup_vault()']) f, unnest(array['anon', 'authenticated', 'service_role']) r
           where has_function_privilege(r, f::regprocedure, 'execute')),
  0, 'F-5 三支 private 輔助函式 anon / authenticated / service_role 都不能直接執行');
select ok(not has_function_privilege('anon', 'public.set_merchant_line_credentials(uuid,text,text,text)', 'execute')
          and has_function_privilege('authenticated', 'public.set_merchant_line_credentials(uuid,text,text,text)', 'execute'),
  'F-6 set_merchant_line_credentials 權限不變(anon 不行、authenticated 可以)');
select ok(not has_function_privilege('authenticated', 'public.claim_birthday_line_pending(integer)', 'execute')
          and not has_function_privilege('authenticated', 'public.internal_prepare_customer_line_job(uuid)', 'execute')
          and has_function_privilege('service_role', 'public.claim_birthday_line_pending(integer)', 'execute')
          and has_function_privilege('service_role', 'public.internal_prepare_customer_line_job(uuid)', 'execute'),
  'F-7 claim / prepare 仍只給 service_role');
select ok((select bool_and(p.prosecdef and p.proconfig = array['search_path=public'])
           from pg_proc p where p.oid in (
             'public.set_merchant_line_credentials(uuid,text,text,text)'::regprocedure,
             'public.get_merchant_line_config_status(uuid)'::regprocedure,
             'public.internal_get_line_messaging_credentials(uuid)'::regprocedure,
             'private.line_messaging_vault_upsert(uuid,text,text,text)'::regprocedure,
             'private.line_messaging_access_token(uuid)'::regprocedure,
             'private.merchant_line_configs_cleanup_vault()'::regprocedure)),
  'F-8 新改的函式都是 security definer + search_path=public');

-- =========================================================================
-- R2 寫入:權限檢查與錯誤訊息不變;寫入後表內無明文、Vault 有值
-- =========================================================================
select pg_temp.as_user('f1053000-0000-4000-8000-000000000002');
select throws_ok($$select public.set_merchant_line_credentials('f1053000-0000-4000-8000-000000000021', '1234567890', 'SECRET1053SENTINELAAAA', 'TOKEN1053SENTINELBBBB')$$,
  '42501', '沒有權限設定這間商家的 LINE 串接憑證', 'W-1 別家管理員不能設定');
select pg_temp.as_user('f1053000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_merchant_line_credentials('f1053000-0000-4000-8000-000000000021', '1234567890', 'SECRET1053SENTINELAAAA', '  ')$$,
  'P0001', 'Channel Access Token 不可為空', 'W-2 token 空白 ⇒ 原本的錯誤訊息');
select lives_ok($$select public.set_merchant_line_credentials('f1053000-0000-4000-8000-000000000021', ' 1234567890 ', ' SECRET1053SENTINELAAAA ', ' TOKEN1053SENTINELBBBB ')$$,
  'W-3 本店管理員設定成功');
select is(public.get_merchant_line_config_status('f1053000-0000-4000-8000-000000000021') ->> 'channel_access_token_masked',
  '••••BBBB', 'W-4 遮罩仍是 •••• + token 末 4 碼');
select ok(public.get_merchant_line_config_status('f1053000-0000-4000-8000-000000000021')::text not like '%SENTINEL%',
  'W-5 狀態回應不含 secret / token 原文');
select pg_temp.as_postgres();

select ok((select c::text from merchant_line_configs c where merchant_id = 'f1053000-0000-4000-8000-000000000021') not like '%SENTINEL%',
  'W-6 表內整列不含 secret / token 原文');
select is((select array[channel_secret_last4, channel_access_token_last4, is_connected::text] from merchant_line_configs where merchant_id = 'f1053000-0000-4000-8000-000000000021'),
  array['AAAA', 'BBBB', 'false'], 'W-7 末 4 碼正確、is_connected 重設為 false');
select is((select ds.decrypted_secret from merchant_line_configs c join vault.decrypted_secrets ds on ds.id = c.channel_secret_vault_id
           where c.merchant_id = 'f1053000-0000-4000-8000-000000000021'),
  'SECRET1053SENTINELAAAA', 'W-8 Vault 裡的 secret 正確(已去頭尾空白)');
select is((select ds.decrypted_secret from merchant_line_configs c join vault.decrypted_secrets ds on ds.id = c.channel_access_token_vault_id
           where c.merchant_id = 'f1053000-0000-4000-8000-000000000021'),
  'TOKEN1053SENTINELBBBB', 'W-9 Vault 裡的 token 正確(已去頭尾空白)');
select is((select array_agg(s.name order by s.name) from merchant_line_configs c join vault.secrets s on s.id in (c.channel_secret_vault_id, c.channel_access_token_vault_id)
           where c.merchant_id = 'f1053000-0000-4000-8000-000000000021'),
  array['line_messaging_access_token:f1053000-0000-4000-8000-000000000021', 'line_messaging_channel_secret:f1053000-0000-4000-8000-000000000021'],
  'W-10 Vault secret 名稱帶 merchant_id 與用途');
select ok((select bool_and(coalesce(s.name, '') not like '%SENTINEL%' and coalesce(s.description, '') not like '%SENTINEL%')
           from vault.secrets s where s.name like 'line_messaging_%'),
  'W-11 Vault secret 名稱 / 說明不含值');
insert into t1053 select 'ids_a', channel_secret_vault_id::text || ',' || channel_access_token_vault_id::text
  from merchant_line_configs where merchant_id = 'f1053000-0000-4000-8000-000000000021';

-- 再設一次(換金鑰):沿用同一筆 Vault、值更新、不多出新 secret
update merchant_line_configs set is_connected = true where merchant_id = 'f1053000-0000-4000-8000-000000000021';
select pg_temp.as_user('f1053000-0000-4000-8000-000000000001');
select lives_ok($$select public.set_merchant_line_credentials('f1053000-0000-4000-8000-000000000021', '1234567890', 'SECRET1053SENTINELCCCC', 'TOKEN1053SENTINELDDDD')$$,
  'W-12 再次設定成功');
select pg_temp.as_postgres();
select is((select channel_secret_vault_id::text || ',' || channel_access_token_vault_id::text from merchant_line_configs where merchant_id = 'f1053000-0000-4000-8000-000000000021'),
  (select v from t1053 where label = 'ids_a'), 'W-13 換金鑰沿用同一組 Vault id');
select is((select ds.decrypted_secret from merchant_line_configs c join vault.decrypted_secrets ds on ds.id = c.channel_access_token_vault_id
           where c.merchant_id = 'f1053000-0000-4000-8000-000000000021'),
  'TOKEN1053SENTINELDDDD', 'W-14 Vault 裡的 token 已更新');
select is((select count(*)::int from vault.secrets where name like 'line_messaging_%:f1053000-0000-4000-8000-000000000021'),
  2, 'W-15 這間店在 Vault 只有 2 筆');
select is((select array[channel_access_token_last4, is_connected::text] from merchant_line_configs where merchant_id = 'f1053000-0000-4000-8000-000000000021'),
  array['DDDD', 'false'], 'W-16 末 4 碼更新、is_connected 重設為 false');

-- 同名殘留(例如之前沒清乾淨)⇒ 沿用那一筆,不會撞名失敗
insert into t1053 values ('leftover_c', vault.create_secret('OLD', 'line_messaging_channel_secret:f1053000-0000-4000-8000-000000000023')::text);
select pg_temp.as_user('f1053000-0000-4000-8000-000000000003');
select lives_ok($$select public.set_merchant_line_credentials('f1053000-0000-4000-8000-000000000023', '1234567893', 'SECRET1053SENTINELEEEE', 'TOKEN1053SENTINELFFFF')$$,
  'W-17 有同名殘留時設定仍成功');
select pg_temp.as_postgres();
select is((select channel_secret_vault_id::text from merchant_line_configs where merchant_id = 'f1053000-0000-4000-8000-000000000023'),
  (select v from t1053 where label = 'leftover_c'), 'W-18 同名殘留被沿用(不留孤兒)');

-- =========================================================================
-- R4 讀取:service_role 拿得到;anon / authenticated 被拒;沒設定 ⇒ null
-- =========================================================================
select pg_temp.as_user('f1053000-0000-4000-8000-000000000001');
select throws_ok($$select public.internal_get_line_messaging_credentials('f1053000-0000-4000-8000-000000000021')$$,
  '42501', null, 'R4-1 authenticated(就算是本店管理員)不能取金鑰');
select pg_temp.as_user('f1053000-0000-4000-8000-000000000001', 'anon');
select throws_ok($$select public.internal_get_line_messaging_credentials('f1053000-0000-4000-8000-000000000021')$$,
  '42501', null, 'R4-2 anon 不能取金鑰');
select pg_temp.as_user('f1053000-0000-4000-8000-000000000001', 'service_role');
select is(public.internal_get_line_messaging_credentials('f1053000-0000-4000-8000-000000000021'),
  jsonb_build_object('channel_secret', 'SECRET1053SENTINELCCCC', 'channel_access_token', 'TOKEN1053SENTINELDDDD'),
  'R4-3 service_role 取得 secret + token');
select is(public.internal_get_line_messaging_credentials('f1053000-0000-4000-8000-000000000022'),
  null::jsonb, 'R4-4 沒設定的店 ⇒ null');
select pg_temp.as_postgres();

-- Vault 那筆不見了 ⇒ 當作未設定(null),不報錯
insert into t1053 select 'tok_c', channel_access_token_vault_id::text from merchant_line_configs where merchant_id = 'f1053000-0000-4000-8000-000000000023';
delete from vault.secrets where id = (select v::uuid from t1053 where label = 'tok_c');
select pg_temp.as_user('f1053000-0000-4000-8000-000000000003', 'service_role');
select is(public.internal_get_line_messaging_credentials('f1053000-0000-4000-8000-000000000023'),
  null::jsonb, 'R4-5 Vault 讀不到 ⇒ null(呼叫端當作 LINE 未設定)');
select pg_temp.as_postgres();

-- prepare / claim:token 來自 Vault(連線中的店)
update merchant_line_configs set is_connected = true where merchant_id = 'f1053000-0000-4000-8000-000000000021';
select is(private.line_messaging_access_token('f1053000-0000-4000-8000-000000000021'),
  'TOKEN1053SENTINELDDDD', 'R4-6 private.line_messaging_access_token 從 Vault 取 token');
select ok((select prosrc not like '%channel_access_token,%' and prosrc like '%private.line_messaging_access_token(v_r.merchant_id)%'
           from pg_proc where oid = 'public.claim_birthday_line_pending(integer)'::regprocedure),
  'R4-7 claim_birthday_line_pending 改從 Vault 取 token');
select ok((select prosrc like '%private.line_messaging_access_token(o.merchant_id)%' and prosrc not like '%v_cfg.channel_access_token%'
           from pg_proc where oid = 'public.internal_prepare_customer_line_job(uuid)'::regprocedure),
  'R4-8 internal_prepare_customer_line_job 改從 Vault 取 token');

-- =========================================================================
-- R3 清除:解除串接 / 商家硬刪連帶刪除 ⇒ Vault 兩筆都刪
-- =========================================================================
select pg_temp.as_user('f1053000-0000-4000-8000-000000000001');
select lives_ok($$select public.disconnect_merchant_line('f1053000-0000-4000-8000-000000000021')$$, 'D-1 解除串接成功');
select pg_temp.as_postgres();
select is((select count(*)::int from vault.secrets where id::text = any(string_to_array((select v from t1053 where label = 'ids_a'), ','))),
  0, 'D-2 解除串接後 Vault 兩筆 secret 都刪掉');

select pg_temp.as_user('f1053000-0000-4000-8000-000000000002');
select lives_ok($$select public.set_merchant_line_credentials('f1053000-0000-4000-8000-000000000022', '1234567892', 'SECRET1053SENTINELGGGG', 'TOKEN1053SENTINELHHHH')$$,
  'D-3 B 店設定成功');
select pg_temp.as_postgres();
insert into t1053 select 'ids_b', channel_secret_vault_id::text || ',' || channel_access_token_vault_id::text
  from merchant_line_configs where merchant_id = 'f1053000-0000-4000-8000-000000000022';
delete from merchant_admins where merchant_id = 'f1053000-0000-4000-8000-000000000022';
delete from merchants where id = 'f1053000-0000-4000-8000-000000000022';
select is((select count(*)::int from vault.secrets where id::text = any(string_to_array((select v from t1053 where label = 'ids_b'), ','))),
  0, 'D-4 商家硬刪(on delete cascade)後 Vault 兩筆 secret 也刪掉');

select * from finish();
rollback;
