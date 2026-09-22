-- 模組 14(服務人員端)規則 2.10 的 pgTAP 半邊:同一 user_id 同時是商家 A 的服務人員、
-- 商家 B 的管理員時,對兩間商家分別查詢角色相關的底層判斷式,結果正確、互不干擾。
-- Vitest 那一半(useMerchantRole 判斷順序:admin > agent > staff)見
-- src/modules/staff-agent/context.test.tsx。

begin;

select plan(6);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

create function pg_temp.test_clear_auth()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- =========================================================================
-- Fixture:同一個人(user X)——是商家 A 的服務人員(已完成登入),同時是商家 B 的管理員。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1430000-0000-4000-8000-000000000001', 'pgtap-m14c-user-x@test.local');

insert into groups (id) values
  ('e1430000-0000-4000-8000-000000000010'),
  ('e1430000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('e1430000-0000-4000-8000-000000000020', 'e1430000-0000-4000-8000-000000000010', '角色優先權測試A店', 'on_site_dispatch'),
  ('e1430000-0000-4000-8000-000000000021', 'e1430000-0000-4000-8000-000000000011', '角色優先權測試B店', 'on_site_dispatch');

-- user X 是 A 店的服務人員(已完成登入)。
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('e1430000-0000-4000-8000-000000000030', 'e1430000-0000-4000-8000-000000000020', 'e1430000-0000-4000-8000-000000000001', 'user X(服務人員身份)', 'piece_rate', 'active', 'active', now(), '0900000101');

-- user X 同時是 B 店的管理員。
insert into merchant_admins (merchant_id, user_id) values
  ('e1430000-0000-4000-8000-000000000021', 'e1430000-0000-4000-8000-000000000001');

select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000001'); -- user X

-- 對 A 店:是服務人員,不是管理員。
select ok(
  private.is_merchant_staff('e1430000-0000-4000-8000-000000000020'),
  '規則 2.10(跨商家互不干擾):user X 對 A 店,is_merchant_staff 回傳 true'
);
select ok(
  not private.is_merchant_admin('e1430000-0000-4000-8000-000000000020'),
  '規則 2.10(跨商家互不干擾):user X 對 A 店,is_merchant_admin 回傳 false(沒有把 B 店的管理員身份誤帶進來)'
);

-- 對 B 店:是管理員,不是服務人員。
select ok(
  private.is_merchant_admin('e1430000-0000-4000-8000-000000000021'),
  '規則 2.10(跨商家互不干擾):user X 對 B 店,is_merchant_admin 回傳 true'
);
select ok(
  not private.is_merchant_staff('e1430000-0000-4000-8000-000000000021'),
  '規則 2.10(跨商家互不干擾):user X 對 B 店,is_merchant_staff 回傳 false(沒有把 A 店的服務人員身份誤帶進來)'
);

-- 兩間商家分別都能透過 merchants_select 正確看到(A 店靠服務人員身份、B 店靠管理員身份)。
select is(
  (select count(*)::int from merchants where id = 'e1430000-0000-4000-8000-000000000020'),
  1,
  '規則 2.10:user X 能看到 A 店(靠服務人員身份)'
);
select is(
  (select count(*)::int from merchants where id = 'e1430000-0000-4000-8000-000000000021'),
  1,
  '規則 2.10:user X 也能看到 B 店(靠管理員身份),兩者互不排斥'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
