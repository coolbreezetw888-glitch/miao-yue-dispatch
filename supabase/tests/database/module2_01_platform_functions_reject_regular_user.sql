-- 模組 2 RLS/規則回歸測試 ①:一般帳號呼叫任何 platform_* 函式會被拒絕。
-- 對應 supabase/migrations/20260915120200_platform_admin_merchant_functions.sql、
-- 20260915120400_platform_admin_read_helpers.sql——這幾支函式的權限檢查
-- (if not private.is_platform_admin() then raise exception ... errcode 42501)一律排在
-- 「查得到查不到指定的商家/集團」之前,所以就算傳一個根本不存在的 id,一般帳號一樣會先被
-- 權限檢查擋下來,不會漏出「這個 id 存不存在」這種本來不該讓一般帳號知道的資訊。
begin;

select plan(5);

insert into auth.users (id, email)
values ('e1000000-0000-4000-8000-000000000001', 'pgtap-regular-user@test.local');

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

select pg_temp.test_set_auth('e1000000-0000-4000-8000-000000000001');

select throws_ok(
  $$select platform_add_merchant_admin('00000000-0000-4000-8000-000000000000', 'nobody@example.com')$$,
  '42501',
  NULL,
  '一般帳號呼叫 platform_add_merchant_admin 會被拒絕(errcode 42501)'
);

select throws_ok(
  $$select platform_remove_merchant_admin('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000')$$,
  '42501',
  NULL,
  '一般帳號呼叫 platform_remove_merchant_admin 會被拒絕'
);

select throws_ok(
  $$select platform_set_group_admin('00000000-0000-4000-8000-000000000000', null)$$,
  '42501',
  NULL,
  '一般帳號呼叫 platform_set_group_admin 會被拒絕'
);

select throws_ok(
  $$select * from platform_get_merchant_admin_counts()$$,
  '42501',
  NULL,
  '一般帳號呼叫 platform_get_merchant_admin_counts 會被拒絕'
);

select throws_ok(
  $$select platform_get_user_email('00000000-0000-4000-8000-000000000000')$$,
  '42501',
  NULL,
  '一般帳號呼叫 platform_get_user_email 會被拒絕'
);

select * from finish();

rollback;
