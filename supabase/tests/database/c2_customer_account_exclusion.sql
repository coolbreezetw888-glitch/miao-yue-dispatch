-- 客戶端第 2 批 QA 修正 — C2-H01 第 3 點:「用 email 找帳號 → 給權限」一律排除客人帳號
--   客人帳號(raw_app_meta_data.account_type = customer)當作「找不到」,訊息跟真的找不到逐字相同。
begin;

select plan(14);

create function pg_temp.as_user(p_user_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;
create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated;
grant execute on function pg_temp.as_postgres() to authenticated;

insert into auth.users (id, email, email_confirmed_at) values
  ('c2f00000-0000-4000-8000-000000000001', 'pgtap-c2x-admin@test.local', now()),
  ('c2f00000-0000-4000-8000-000000000002', 'pgtap-c2x-platform@test.local', now()),
  ('c2f00000-0000-4000-8000-000000000003', 'pgtap-c2x-normal@test.local', now());
insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data) values
  ('c2f00000-0000-4000-8000-0000000000c1', 'line-pgtap-c2x@customer.miaoyue.invalid', now(), '{"account_type":"customer"}');
insert into groups (id) values ('c2f00000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c2f00000-0000-4000-8000-000000000021', 'c2f00000-0000-4000-8000-000000000011', 'C2 排除客人店', 'in_store_beauty', 'pgtap-c2x', 'active');
insert into merchant_admins (merchant_id, user_id) values ('c2f00000-0000-4000-8000-000000000021', 'c2f00000-0000-4000-8000-000000000001');
insert into platform_admins (user_id) values ('c2f00000-0000-4000-8000-000000000002');

-- invite_merchant_admin
select pg_temp.as_user('c2f00000-0000-4000-8000-000000000001');
select throws_ok($$select public.invite_merchant_admin('c2f00000-0000-4000-8000-000000000021', 'line-pgtap-c2x@customer.miaoyue.invalid')$$,
  'P0002', '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號', 'X-1 管理員邀請客人帳號 ⇒ 跟查無此人同一句');
select throws_ok($$select public.invite_merchant_admin('c2f00000-0000-4000-8000-000000000021', '  LINE-PGTAP-C2X@Customer.Miaoyue.Invalid ')$$,
  'P0002', '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號', 'X-2 大小寫 / 空白不同也一樣擋');
select throws_ok($$select public.invite_merchant_admin('c2f00000-0000-4000-8000-000000000021', 'nobody-c2x@test.local')$$,
  'P0002', '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號', 'X-3 對照:真的查無此人 ⇒ 同一句');
select lives_ok($$select public.invite_merchant_admin('c2f00000-0000-4000-8000-000000000021', 'pgtap-c2x-normal@test.local')$$,
  'X-4 一般帳號照常可以邀請');

-- platform_add_merchant_admin / platform_set_group_admin
select pg_temp.as_user('c2f00000-0000-4000-8000-000000000002');
select throws_ok($$select public.platform_add_merchant_admin('c2f00000-0000-4000-8000-000000000021', 'line-pgtap-c2x@customer.miaoyue.invalid')$$,
  'P0002', '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號', 'X-5 平台加管理員:客人帳號當作找不到');
select throws_ok($$select public.platform_set_group_admin('c2f00000-0000-4000-8000-000000000011', 'line-pgtap-c2x@customer.miaoyue.invalid')$$,
  'P0002', '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號', 'X-6 平台指定集團管理者:客人帳號當作找不到');
select lives_ok($$select public.platform_set_group_admin('c2f00000-0000-4000-8000-000000000011', 'pgtap-c2x-normal@test.local')$$,
  'X-7 一般帳號照常可以指定');
select pg_temp.as_postgres();

select is((select count(*)::int from merchant_admins where user_id = 'c2f00000-0000-4000-8000-0000000000c1')
          + (select count(*)::int from groups where group_admin_user_id = 'c2f00000-0000-4000-8000-0000000000c1'),
          0, 'X-8 客人帳號沒有變成任何商家 / 集團的管理者');

-- 客人帳號登入後也不是管理員(QA 實測情境)
select pg_temp.as_user('c2f00000-0000-4000-8000-0000000000c1');
select is(public.am_i_merchant_admin('c2f00000-0000-4000-8000-000000000021'), false, 'X-9 客人帳號 am_i_merchant_admin = false');
select pg_temp.as_postgres();

-- Edge Function 用的查詢(service_role)
set local role service_role;
select is((select count(*)::int from public.lookup_auth_account_by_email('line-pgtap-c2x@customer.miaoyue.invalid')), 0,
          'X-10 lookup_auth_account_by_email:客人帳號查無帳號');
select is((select count(*)::int from public.lookup_auth_account_by_email('pgtap-c2x-normal@test.local')), 1,
          'X-11 對照:一般帳號查得到');
select is(public.lookup_user_id_by_email('LINE-pgtap-c2x@customer.miaoyue.invalid'), null, 'X-12 lookup_user_id_by_email:客人帳號查無帳號');
select is(public.lookup_user_id_by_email('pgtap-c2x-normal@test.local'), 'c2f00000-0000-4000-8000-000000000003'::uuid, 'X-13 對照:一般帳號查得到');
reset role;

-- 沒有 account_type 的舊帳號(null)不受影響
select is((select count(*)::int from auth.users where id = 'c2f00000-0000-4000-8000-000000000003' and raw_app_meta_data ->> 'account_type' is null), 1,
          'X-14 對照組的一般帳號確實沒有 account_type(null 不會被誤擋)');

select * from finish();
rollback;
