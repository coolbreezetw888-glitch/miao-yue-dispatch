-- 客戶端第 2 批 — Edge Function customer-line-login 用的 internal_* 函式(以 service_role 呼叫)
--   C2-B01 頻率限制 / 不可用、C2-B03 單次有效 / 過期 / 草稿清空、C2-C02 identity、C2-F01 credentials
begin;

select plan(24);

insert into auth.users (id, email) values ('c2d00000-0000-4000-8000-000000000001', 'pgtap-c2i-admin@test.local');
insert into auth.users (id, email, raw_app_meta_data) values
  ('c2d00000-0000-4000-8000-0000000000c1', 'line-pgtap-c2i-1@customer.miaoyue.invalid', '{"account_type":"customer"}'),
  ('c2d00000-0000-4000-8000-0000000000c2', 'line-pgtap-c2i-2@customer.miaoyue.invalid', '{"account_type":"customer"}');
insert into groups (id) values ('c2d00000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c2d00000-0000-4000-8000-000000000021', 'c2d00000-0000-4000-8000-000000000011', 'C2 內部店', 'in_store_beauty', 'pgtap-c2i', 'active'),
  ('c2d00000-0000-4000-8000-000000000022', 'c2d00000-0000-4000-8000-000000000011', 'C2 未啟用店', 'in_store_beauty', 'pgtap-c2i-off', 'active');
insert into merchant_admins (merchant_id, user_id) values ('c2d00000-0000-4000-8000-000000000021', 'c2d00000-0000-4000-8000-000000000001');

-- 用正式函式寫入設定(Vault)
select set_config('request.jwt.claims', '{"sub":"c2d00000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.set_merchant_line_login_config('c2d00000-0000-4000-8000-000000000021', '1234567890', 'SENTINELSECRET0123456789abcdef01');
select public.set_merchant_line_login_enabled('c2d00000-0000-4000-8000-000000000021', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

-- =========================================================================
-- start
-- =========================================================================
select is(public.internal_customer_line_login_start('pgtap-c2i-off', repeat('a', 64), 'n', 'v', '{}', 'ip0'), '{"status": "line_login_unavailable"}'::jsonb, 'I-1 沒有設定 ⇒ unavailable');
select is(public.internal_customer_line_login_start('pgtap-c2i-none', repeat('a', 64), 'n', 'v', '{}', 'ip0'), '{"status": "line_login_unavailable"}'::jsonb, 'I-2 不存在 ⇒ unavailable');
select is(public.internal_customer_line_login_start(' PGTAP-C2I ', repeat('b', 64), 'nonce-b', 'verifier-b', '{"name":"王"}', 'ip1'),
          '{"status": "ok", "channel_id": "1234567890"}'::jsonb, 'I-3 啟用中 ⇒ ok + channel_id(代碼大小寫 / 空白不影響)');
select ok((select expires_at - created_at = interval '10 minutes' from customer_line_login_attempts where state_hash = repeat('b', 64)), 'I-4 10 分鐘有效');

select is((select count(*)::int from generate_series(1, 29) i
           where public.internal_customer_line_login_start('pgtap-c2i', lpad(to_hex(i), 64, 'c'), 'n', 'v', '{}', 'ip1') ->> 'status' = 'ok'),
          29, 'I-5 同 IP 10 分鐘內前 30 次都可以');
select is(public.internal_customer_line_login_start('pgtap-c2i', repeat('d', 64), 'n', 'v', '{}', 'ip1'), '{"status": "rate_limited"}'::jsonb, 'I-6 第 31 次 ⇒ rate_limited');
select is(public.internal_customer_line_login_start('pgtap-c2i', repeat('e', 64), 'n', 'v', '{}', 'ip2') ->> 'status', 'ok', 'I-7 別的 IP 不受影響');
select throws_ok($$select public.internal_customer_line_login_start('pgtap-c2i', 'NOT-A-HASH', 'n', 'v', '{}', 'ip3')$$, '23514', null, 'I-8 state_hash 一定要是 64 位十六進位');

-- =========================================================================
-- consume
-- =========================================================================
select is(public.internal_customer_line_login_consume(repeat('b', 64)) - 'merchant_id',
          '{"status": "ok", "slug": "pgtap-c2i", "channel_id": "1234567890", "nonce": "nonce-b", "code_verifier": "verifier-b", "draft": {"name": "王"}}'::jsonb,
          'I-9 第一次 consume 回全部資料 + 草稿');
select is((select coalesce(draft::text, 'null') || '/' || (consumed_at is not null) from customer_line_login_attempts where state_hash = repeat('b', 64)), 'null/true',
          'I-10 用過之後草稿已清空、標成已使用');
select is(public.internal_customer_line_login_consume(repeat('b', 64)), '{"status": "login_expired", "slug": "pgtap-c2i"}'::jsonb, 'I-11 第二次 ⇒ login_expired + slug(前端可顯示回店家首頁)');
update customer_line_login_attempts set expires_at = now() - interval '1 second' where state_hash = repeat('e', 64);
select is(public.internal_customer_line_login_consume(repeat('e', 64)), '{"status": "login_expired", "slug": "pgtap-c2i"}'::jsonb, 'I-12 過期 ⇒ login_expired + slug');
select is(public.internal_customer_line_login_consume(repeat('f', 64)), '{"status": "login_expired"}'::jsonb, 'I-13 不存在(偽造的 state)⇒ login_expired,不帶 slug');

-- =========================================================================
-- credentials / identity / succeeded
-- =========================================================================
select is(public.internal_get_line_login_credentials('c2d00000-0000-4000-8000-000000000021'),
          '{"channel_id": "1234567890", "channel_secret": "SENTINELSECRET0123456789abcdef01", "enabled": true, "merchant_active": true}'::jsonb,
          'I-14 service_role 拿得到 Channel Secret');

select is(public.internal_customer_line_identity_upsert('c2d00000-0000-4000-8000-0000000000c1', '1234567890', 'Usub1', 'LINE 名', 'http://not-https/x.png'),
          '{"user_id": "c2d00000-0000-4000-8000-0000000000c1", "email": "line-pgtap-c2i-1@customer.miaoyue.invalid"}'::jsonb, 'I-15 新 identity');
select is(public.internal_customer_line_identity_upsert('c2d00000-0000-4000-8000-0000000000c2', '1234567890', 'Usub1', '改名', 'https://x/y.png') ->> 'user_id',
          'c2d00000-0000-4000-8000-0000000000c1', 'I-16 同 channel + sub 再寫一次 ⇒ 回原本的帳號(競態時呼叫端刪多的)');
select throws_ok($$select public.internal_customer_line_identity_upsert('c2d00000-0000-4000-8000-000000000001', '1234567890', 'Uadmin', null, null)$$,
                 '42501', '這個登入帳號不是客戶帳號。', 'I-17 非客戶帳號不能寫成 LINE 客戶身分');
select is(public.internal_customer_line_identity_find('1234567890', 'Usub1') ->> 'user_id', 'c2d00000-0000-4000-8000-0000000000c1', 'I-18 find 找得到');
select is(public.internal_customer_line_identity_find('9999999999', 'Usub1'), null, 'I-19 不同 channel 同 sub 找不到');
reset role;
select is((select display_name || '/' || picture_url from customer_line_identities where user_id = 'c2d00000-0000-4000-8000-0000000000c1'), '改名/https://x/y.png',
          'I-20 名稱 / 頭像更新');
set local role service_role;
select public.internal_customer_line_login_succeeded('c2d00000-0000-4000-8000-000000000021', '0000000000', 'ok');
reset role;
select is((select last_login_succeeded_at from merchant_line_login_configs where merchant_id = 'c2d00000-0000-4000-8000-000000000021'), null,
          'I-21 Channel ID 對不上 ⇒ 不記錄成功');
set local role service_role;
select public.internal_customer_line_login_succeeded('c2d00000-0000-4000-8000-000000000021', '1234567890', 'weird');
reset role;
select is((select (last_login_succeeded_at is not null) || '/' || linked_oa_status from merchant_line_login_configs where merchant_id = 'c2d00000-0000-4000-8000-000000000021'),
          'true/unknown', 'I-22 對得上 ⇒ 記錄;不認識的狀態寫 unknown');
select is(private.prune_customer_line_login_attempts() >= 0, true, 'I-23 清理函式可以執行');
update customer_line_login_attempts set created_at = now() - interval '25 hours' where state_hash = repeat('b', 64);
select private.prune_customer_line_login_attempts();
select is((select count(*)::int from customer_line_login_attempts where state_hash = repeat('b', 64)), 0, 'I-24 1 天前的暫存被清掉');

select * from finish();
rollback;
