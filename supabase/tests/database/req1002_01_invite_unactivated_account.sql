-- 第 13 批 #1002(規格書 .project/specs/重複邀請未開通帳號狀態錯誤-第13批.md):
-- ① lookup_auth_account_by_email 的權限與「開通」判斷(email 已確認 + 沒有還停在 invited 的紀錄)。
-- ② mark_agent_active_if_self / mark_staff_login_active_if_self 會把本人在所有商家、客服與服務人員
--    兩張表裡的 invited 紀錄一起轉 active,而且不會動到別人的紀錄。
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(24);

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
-- Fixture
--   X:只收過邀請、從沒點連結(email 未確認、沒密碼)
--   P:點過連結但還沒走完轉場頁(email 已確認、A 商家客服紀錄仍是 invited)
--   Q:已開通(email 已確認、沒有 invited 紀錄;A 商家有一筆 active 客服)
--   R:被 bug 誤寫成 active、其實從沒點連結(email 未確認、有 active 紀錄)→ 不可以被當成已開通
--   Y:另一個未開通的人(用來證明 X 轉換時不會波及別人)
--   Z:A 商家客服 invited + B 商家服務人員 invited,用服務人員轉場頁轉換
-- =========================================================================
insert into auth.users (id, email, email_confirmed_at, encrypted_password) values
  ('f1002000-0000-4000-8000-000000000001', 'pgtap-1002-x@test.local', null, ''),
  ('f1002000-0000-4000-8000-000000000002', 'pgtap-1002-p@test.local', now(), 'random-hash-from-verify'),
  ('f1002000-0000-4000-8000-000000000003', 'pgtap-1002-q@test.local', now(), 'hashed-password'),
  ('f1002000-0000-4000-8000-000000000006', 'pgtap-1002-r@test.local', null, ''),
  ('f1002000-0000-4000-8000-000000000004', 'pgtap-1002-y@test.local', null, ''),
  ('f1002000-0000-4000-8000-000000000005', 'pgtap-1002-z@test.local', null, '');

insert into groups (id) values
  ('f1002000-0000-4000-8000-000000000010'),
  ('f1002000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('f1002000-0000-4000-8000-000000000020', 'f1002000-0000-4000-8000-000000000010', '#1002 測試商家A', 'on_site_dispatch'),
  ('f1002000-0000-4000-8000-000000000021', 'f1002000-0000-4000-8000-000000000011', '#1002 測試商家B', 'on_site_dispatch');

insert into merchant_staff (id, merchant_id, name, status, phone) values
  ('f1002000-0000-4000-8000-000000000030', 'f1002000-0000-4000-8000-000000000021', 'X 在 B 的服務人員', 'active', '0900100201'),
  ('f1002000-0000-4000-8000-000000000031', 'f1002000-0000-4000-8000-000000000021', 'Z 在 B 的服務人員', 'active', '0900100202');

select record_invited_merchant_agent('f1002000-0000-4000-8000-000000000020', 'f1002000-0000-4000-8000-000000000001', 'pgtap-1002-x@test.local', 'X在A', null, '0900100211', 'invited');
select record_invited_merchant_agent('f1002000-0000-4000-8000-000000000021', 'f1002000-0000-4000-8000-000000000001', 'pgtap-1002-x@test.local', 'X在B', null, '0900100212', 'invited');
select record_invited_merchant_agent('f1002000-0000-4000-8000-000000000020', 'f1002000-0000-4000-8000-000000000004', 'pgtap-1002-y@test.local', 'Y在A', null, '0900100213', 'invited');
select record_invited_merchant_agent('f1002000-0000-4000-8000-000000000020', 'f1002000-0000-4000-8000-000000000005', 'pgtap-1002-z@test.local', 'Z在A', null, '0900100214', 'invited');
select record_invited_merchant_agent('f1002000-0000-4000-8000-000000000020', 'f1002000-0000-4000-8000-000000000002', 'pgtap-1002-p@test.local', 'P在A', null, '0900100215', 'invited');
select record_invited_merchant_agent('f1002000-0000-4000-8000-000000000020', 'f1002000-0000-4000-8000-000000000003', 'pgtap-1002-q@test.local', 'Q在A', null, '0900100216', 'active');
select record_invited_merchant_agent('f1002000-0000-4000-8000-000000000020', 'f1002000-0000-4000-8000-000000000006', 'pgtap-1002-r@test.local', 'R在A', null, '0900100217', 'active');
select record_invited_staff_login('f1002000-0000-4000-8000-000000000030', 'f1002000-0000-4000-8000-000000000001', 'pgtap-1002-x@test.local', 'invited');
select record_invited_staff_login('f1002000-0000-4000-8000-000000000031', 'f1002000-0000-4000-8000-000000000005', 'pgtap-1002-z@test.local', 'invited');

-- =========================================================================
-- ① lookup_auth_account_by_email:權限
-- =========================================================================
select ok(
  not has_function_privilege('authenticated', 'public.lookup_auth_account_by_email(text)', 'execute'),
  '①:authenticated 不能呼叫 lookup_auth_account_by_email(只給 Edge Function 的 service role)'
);
select ok(
  not has_function_privilege('anon', 'public.lookup_auth_account_by_email(text)', 'execute'),
  '①:anon 不能呼叫 lookup_auth_account_by_email'
);
select ok(
  has_function_privilege('service_role', 'public.lookup_auth_account_by_email(text)', 'execute'),
  '①(正向對照):service_role 可以呼叫 lookup_auth_account_by_email'
);

-- ① 開通判斷
select is(
  (select row(email_confirmed, is_activated)::text from lookup_auth_account_by_email('pgtap-1002-x@test.local')),
  '(f,f)',
  '①:只收過邀請、沒點連結 → 未確認、未開通'
);
select is(
  (select row(email_confirmed, is_activated)::text from lookup_auth_account_by_email('pgtap-1002-p@test.local')),
  '(t,f)',
  '①:點過連結(GoTrue 已寫入一組密碼雜湊)但還有 invited 紀錄 → 已確認、未開通'
);
select is(
  (select row(email_confirmed, is_activated)::text from lookup_auth_account_by_email('pgtap-1002-q@test.local')),
  '(t,t)',
  '①:email 已確認、沒有 invited 紀錄 → 已開通'
);
select is(
  (select row(email_confirmed, is_activated)::text from lookup_auth_account_by_email('pgtap-1002-r@test.local')),
  '(f,f)',
  '①:被 bug 誤寫成 active 但 email 從沒確認 → 不算開通(不會被髒資料騙)'
);
select is(
  (select user_id from lookup_auth_account_by_email('  PGTAP-1002-Q@test.local ')),
  'f1002000-0000-4000-8000-000000000003'::uuid,
  '①:email 比對不分大小寫、會去掉前後空白(跟舊 lookup_user_id_by_email 一致)'
);
select is(
  (select count(*)::int from lookup_auth_account_by_email('pgtap-1002-nobody@test.local')),
  0,
  '①:查無帳號 → 0 列'
);

-- =========================================================================
-- ② 客服轉場頁:X 呼叫 mark_agent_active_if_self
-- =========================================================================
select pg_temp.test_set_auth('f1002000-0000-4000-8000-000000000001');
select lives_ok($$select mark_agent_active_if_self()$$, '②:X 呼叫 mark_agent_active_if_self 成功');
select pg_temp.test_clear_auth();

select is(
  (select status from merchant_agents where merchant_id = 'f1002000-0000-4000-8000-000000000020' and user_id = 'f1002000-0000-4000-8000-000000000001'),
  'active',
  '②:X 在 A 商家的客服紀錄變 active'
);
select is(
  (select status from merchant_agents where merchant_id = 'f1002000-0000-4000-8000-000000000021' and user_id = 'f1002000-0000-4000-8000-000000000001'),
  'active',
  '②(規則 4):X 在 B 商家的客服紀錄也一起變 active'
);
select isnt(
  (select activated_at from merchant_agents where merchant_id = 'f1002000-0000-4000-8000-000000000021' and user_id = 'f1002000-0000-4000-8000-000000000001'),
  null,
  '②:B 商家紀錄的 activated_at 有寫入'
);
select is(
  (select login_status from merchant_staff where id = 'f1002000-0000-4000-8000-000000000030'),
  'active',
  '②(#1002 新增):X 在 B 商家的服務人員登入紀錄也一起變 active(客服轉場頁也會轉服務人員表)'
);
select is(
  (select status from merchant_agents where user_id = 'f1002000-0000-4000-8000-000000000004'),
  'invited',
  '②:別人(Y)的 invited 客服紀錄不受影響'
);
select is(
  (select status from merchant_agents where user_id = 'f1002000-0000-4000-8000-000000000005'),
  'invited',
  '②:別人(Z)的 invited 客服紀錄不受影響'
);
select is(
  (select login_status from merchant_staff where id = 'f1002000-0000-4000-8000-000000000031'),
  'invited',
  '②:別人(Z)的 invited 服務人員紀錄不受影響'
);

-- =========================================================================
-- ③ 服務人員轉場頁:Z 呼叫 mark_staff_login_active_if_self
-- =========================================================================
select pg_temp.test_set_auth('f1002000-0000-4000-8000-000000000005');
select lives_ok($$select mark_staff_login_active_if_self()$$, '③:Z 呼叫 mark_staff_login_active_if_self 成功(沒有被身分欄位保護 trigger 擋下)');
select pg_temp.test_clear_auth();

select is(
  (select login_status from merchant_staff where id = 'f1002000-0000-4000-8000-000000000031'),
  'active',
  '③:Z 在 B 商家的服務人員登入紀錄變 active'
);
select is(
  (select status from merchant_agents where user_id = 'f1002000-0000-4000-8000-000000000005'),
  'active',
  '③(#1002 新增):Z 在 A 商家的客服紀錄也一起變 active'
);
select is(
  (select status from merchant_agents where user_id = 'f1002000-0000-4000-8000-000000000004'),
  'invited',
  '③:Y 的紀錄依然不受影響'
);

-- ③-2 P 走完轉場頁後,lookup 判斷變成已開通(跟既有轉換同一個標準)
select pg_temp.test_set_auth('f1002000-0000-4000-8000-000000000002');
select mark_agent_active_if_self();
select pg_temp.test_clear_auth();
select is(
  (select row(email_confirmed, is_activated)::text from lookup_auth_account_by_email('pgtap-1002-p@test.local')),
  '(t,t)',
  '③-2:P 在轉場頁完成後(沒有 invited 紀錄了)→ 已開通,之後別家邀請會直接 active'
);
select is(
  (select status from merchant_agents where user_id = 'f1002000-0000-4000-8000-000000000003'),
  'active',
  '③-2:Q 原本的 active 紀錄不受 P 影響'
);

-- ④ 未登入呼叫仍然被擋(權限沒有退步)
select pg_temp.test_set_auth(null, 'anon');
select throws_ok(
  $$select mark_agent_active_if_self()$$,
  '42501',
  null,
  '④:anon 不能呼叫 mark_agent_active_if_self(EXECUTE 權限維持只給 authenticated)'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
