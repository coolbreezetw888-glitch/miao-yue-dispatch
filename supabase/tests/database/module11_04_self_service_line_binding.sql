-- 模組 11(LINE 通知)× 模組 14(服務人員端)— 服務人員自助 LINE 綁定。
-- 對應 migration:20260924040900_self_service_line_binding.sql
--
-- 【為什麼需要這份測試】
-- 2026-09-24 使用者裁決「要讓服務人員自己綁定」,於是:
--   (a) 新增 generate_own_staff_line_binding_code(p_merchant_id) —— 函式自己用 auth.uid()
--       解析出「我在這間商家的那一列」,前端無法指定別人。
--   (b) unbind_line_account 的 staff 分支從「只有管理員」放寬成「管理員或本人」。
--   (c) 新增 get_merchant_line_bot_public_info(p_merchant_id) —— 只回傳三個公開欄位,
--       讓服務人員/客服拿到加好友連結,而不需要放寬管理員專用的
--       get_merchant_line_config_status。
--
-- 這份測試刻意不只測 happy path。三個重點:
--   1. 「函式自己解析身分」真的有效 —— 服務人員 A 不可能替服務人員 B 產生綁定碼,
--      也不可能解除 B 的綁定(這是 (a) 那個設計的全部理由,必須釘死)。
--   2. 迴歸保護 —— 管理員原本能做的每一件事都還能做。放寬權限最容易的失手方式是
--      「改權限判斷式的時候把原本那一半寫壞」。
--   3. 窄函式真的窄 —— 明確斷言回傳的 JSON **不含**任何憑證/串接排查欄位,
--      不是只斷言「該有的欄位有」。
--   4. (⑤ 段)順帶修掉的既有三值邏輯漏洞 —— unbind_line_account 的 admin/agent 分支原本
--      裸寫 `or v_self_user_id = auth.uid()`,遇到 user_id 為 NULL 的列時權限檢查被靜默跳過。
--      每個情境都同時斷言「有拋 42501」**和**「資料真的沒被改動」,因為漏洞的症狀正是
--      「raise 沒觸發但 UPDATE 執行了」,只看 throws_ok 抓不到。
--
-- 比照 module11_02_line_notifications_binding_and_dispatch.sql /
-- security_audit_01_execute_privileges_and_policy_roles.sql 的既有寫法。
begin;

select plan(47);

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
-- ⓪ 三支新/改函式的 EXECUTE 權限邊界(權限衛生規則 1:新增函式不可以又開一個洞)。
--    這一段刻意放在 fixture 之前 —— 它只看 catalog,不需要任何資料。
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.generate_own_staff_line_binding_code(uuid)', 'execute'),
  '(a) 權限:anon 不能執行 generate_own_staff_line_binding_code'
);
select ok(
  not has_function_privilege('public', 'public.generate_own_staff_line_binding_code(uuid)', 'execute'),
  '(a) 權限:PUBLIC 虛擬角色沒有 generate_own_staff_line_binding_code 的執行權'
);
select ok(
  has_function_privilege('authenticated', 'public.generate_own_staff_line_binding_code(uuid)', 'execute'),
  '(a) 權限:authenticated 保有執行權(服務人員本人要用,函式內部自己檢查身分)'
);

select ok(
  not has_function_privilege('anon', 'public.get_merchant_line_bot_public_info(uuid)', 'execute'),
  '(c) 權限:anon 不能執行 get_merchant_line_bot_public_info'
);
select ok(
  not has_function_privilege('public', 'public.get_merchant_line_bot_public_info(uuid)', 'execute'),
  '(c) 權限:PUBLIC 虛擬角色沒有 get_merchant_line_bot_public_info 的執行權'
);
select ok(
  has_function_privilege('authenticated', 'public.get_merchant_line_bot_public_info(uuid)', 'execute'),
  '(c) 權限:authenticated 保有執行權(管理員/客服/服務人員都要用)'
);

select ok(
  not has_function_privilege('anon', 'public.unbind_line_account(text, uuid)', 'execute'),
  '(b) 權限:anon 不能執行 unbind_line_account(create or replace 不會弄丟既有的 revoke)'
);
select ok(
  not has_function_privilege('public', 'public.unbind_line_account(text, uuid)', 'execute'),
  '(b) 權限:PUBLIC 虛擬角色沒有 unbind_line_account 的執行權'
);
select ok(
  has_function_privilege('authenticated', 'public.unbind_line_account(text, uuid)', 'execute'),
  '(b) 權限:authenticated 保有 unbind_line_account 的執行權'
);

-- =========================================================================
-- Fixture
--   A 店(ef…0021,已完成 LINE 串接):
--     ・管理員      user ef…0001
--     ・在職客服    user ef…0002 / agent ef…0051
--     ・服務人員 X  user ef…0003 / staff ef…0041  (status=active, login_status=active)
--     ・服務人員 Y  user ef…0004 / staff ef…0042  (status=active, login_status=active)
--     ・服務人員 Z  user ef…0005 / staff ef…0043  (status=removed  ← 已離職)
--     ・服務人員 W  user ef…0006 / staff ef…0044  (login_status=invited ← 未開通登入)
--     ・客服(已邀請未註冊)agent ef…0052  (user_id = NULL ← ⑤ 三值邏輯漏洞的主角)
--     ・管理員那一列的 id 是 ef…0061(⑤ 要直接指定它)
--   B 店(ef…0022,尚未串接 LINE):管理員 user ef…0007 / merchant_admins ef…0062
--   路人 user ef…0008(跟任何商家都沒有關係)
--
-- ⚠️ 這裡的 insert 帶了 user_id / login_status,會經過
--    merchant_staff_protect_identity_columns 觸發器。以 postgres 身分執行、沒有設定
--    request.jwt.claims 時 auth.role() 是 NULL,整個 AND 條件鏈結果為 NULL、不會拋錯——
--    跟 module14_01/module15_01 等既有測試的 fixture 完全同一個機制,不是這裡的特例。
-- =========================================================================
insert into auth.users (id, email) values
  ('ef000000-0000-4000-8000-000000000001', 'pgtap-m11d-admin@test.local'),
  ('ef000000-0000-4000-8000-000000000002', 'pgtap-m11d-agent@test.local'),
  ('ef000000-0000-4000-8000-000000000003', 'pgtap-m11d-staffx@test.local'),
  ('ef000000-0000-4000-8000-000000000004', 'pgtap-m11d-staffy@test.local'),
  ('ef000000-0000-4000-8000-000000000005', 'pgtap-m11d-staffz@test.local'),
  ('ef000000-0000-4000-8000-000000000006', 'pgtap-m11d-staffw@test.local'),
  ('ef000000-0000-4000-8000-000000000007', 'pgtap-m11d-adminb@test.local'),
  ('ef000000-0000-4000-8000-000000000008', 'pgtap-m11d-outsider@test.local');

insert into groups (id) values
  ('ef000000-0000-4000-8000-000000000011'),
  ('ef000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ef000000-0000-4000-8000-000000000021', 'ef000000-0000-4000-8000-000000000011', '自助綁定測試A店', 'in_store_beauty'),
  ('ef000000-0000-4000-8000-000000000022', 'ef000000-0000-4000-8000-000000000012', '自助綁定測試B店', 'in_store_beauty');

-- id 刻意寫死(不用 gen_random_uuid 預設值):下面 ⑤ 的三值邏輯漏洞迴歸測試需要直接指定
-- merchant_admins.id 來模擬「路人拿著一個已知 UUID 去打 unbind_line_account」。
insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('ef000000-0000-4000-8000-000000000061', 'ef000000-0000-4000-8000-000000000021',
   'ef000000-0000-4000-8000-000000000001', '自助綁定測試管理員'),
  ('ef000000-0000-4000-8000-000000000062', 'ef000000-0000-4000-8000-000000000022',
   'ef000000-0000-4000-8000-000000000007', 'B店管理員');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ef000000-0000-4000-8000-000000000051', 'ef000000-0000-4000-8000-000000000021',
   'ef000000-0000-4000-8000-000000000002', '自助綁定測試客服', 'pgtap-m11d-agent@test.local',
   'active', now(), '0900000201'),
  -- ⑤ 三值邏輯漏洞的主角:「已邀請但還沒完成註冊」的客服 —— user_id 是 NULL。
  -- merchant_agents_merchant_user_unique 是 `where user_id is not null`,所以 NULL 不會撞唯一索引。
  ('ef000000-0000-4000-8000-000000000052', 'ef000000-0000-4000-8000-000000000021',
   null, '自助綁定測試客服(已邀請未註冊)', 'pgtap-m11d-agent-pending@test.local',
   'invited', null, '0900000202');

insert into merchant_staff (id, merchant_id, user_id, name, phone, compensation_type, status, login_status, login_activated_at) values
  ('ef000000-0000-4000-8000-000000000041', 'ef000000-0000-4000-8000-000000000021',
   'ef000000-0000-4000-8000-000000000003', '服務人員X(在職已開通)', '0922000201', 'piece_rate', 'active', 'active', now()),
  ('ef000000-0000-4000-8000-000000000042', 'ef000000-0000-4000-8000-000000000021',
   'ef000000-0000-4000-8000-000000000004', '服務人員Y(在職已開通)', '0922000202', 'piece_rate', 'active', 'active', now()),
  ('ef000000-0000-4000-8000-000000000043', 'ef000000-0000-4000-8000-000000000021',
   'ef000000-0000-4000-8000-000000000005', '服務人員Z(已離職)', '0922000203', 'piece_rate', 'removed', 'active', now()),
  ('ef000000-0000-4000-8000-000000000044', 'ef000000-0000-4000-8000-000000000021',
   'ef000000-0000-4000-8000-000000000006', '服務人員W(未開通登入)', '0922000204', 'piece_rate', 'active', 'invited', null);

-- A 店已完成串接(直接寫入 merchant_line_configs 模擬跑過 line-test-connection 的結果,
-- 比照 module11_02 既有 fixture 的做法)。B 店刻意完全沒有這一列。
insert into merchant_line_configs (
  merchant_id, channel_id, channel_secret, channel_access_token,
  line_bot_user_id, line_bot_basic_id, display_name, is_connected
) values (
  'ef000000-0000-4000-8000-000000000021', '2000000201', 'secret-must-never-leak-201',
  'token-must-never-leak-201', 'Um11dbotuser000201', 'm11dshop', '自助綁定測試官方帳號', true
);

-- =========================================================================
-- ① (a) generate_own_staff_line_binding_code —— 自己產生綁定碼 + 身分解析邊界。
-- =========================================================================
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000003'); -- 服務人員 X 本人
select code, expires_at from generate_own_staff_line_binding_code('ef000000-0000-4000-8000-000000000021') \gset xcode1_
select pg_temp.test_clear_auth();

select ok(
  :'xcode1_code' ~ '^[0-9]{6}$',
  '(a):在職且已開通登入的服務人員可以自己產生綁定碼,格式是 6 碼數字(規則比照既有 3.6,共用 private.issue_line_binding_code)'
);

select is(
  (select row(target_type, target_id)::text from line_binding_codes where code = :'xcode1_code'),
  row('staff', 'ef000000-0000-4000-8000-000000000041'::uuid)::text,
  '(a) 核心必測:綁定碼的目標就是「呼叫者自己那一列」——由函式用 auth.uid() 解析,前端沒有機會指定別人'
);

select ok(
  (select expires_at from line_binding_codes where code = :'xcode1_code')
    between now() + interval '9 minutes' and now() + interval '11 minutes',
  '(a):有效期限是 10 分鐘,跟既有 3.6 完全一致(同一支 private.issue_line_binding_code)'
);

select is(
  (select count(*)::int from line_binding_codes
    where target_type = 'staff' and target_id = 'ef000000-0000-4000-8000-000000000042'
      and used_at is null and expires_at > now()),
  0,
  '(a) 核心必測:服務人員 X 呼叫之後,完全沒有產生任何指向服務人員 Y 的綁定碼'
);

-- 舊的 3.6(帶 p_staff_id)仍然只給管理員 —— 這是「服務人員不能幫別人產生綁定碼」的另一半保證。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000003');
select throws_ok(
  $$select generate_staff_line_binding_code('ef000000-0000-4000-8000-000000000042')$$,
  '42501', null,
  '(a) 核心必測:服務人員 X 想用舊的 generate_staff_line_binding_code 幫服務人員 Y 產生綁定碼,被擋下'
);
select pg_temp.test_clear_auth();

-- 服務人員 Y 自己呼叫,拿到的是「Y 自己」的碼 —— 證明 auth.uid() 解析是真的按人區分,不是寫死。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000004');
select code from generate_own_staff_line_binding_code('ef000000-0000-4000-8000-000000000021') \gset ycode1_
select pg_temp.test_clear_auth();

select is(
  (select target_id from line_binding_codes where code = :'ycode1_code'),
  'ef000000-0000-4000-8000-000000000042'::uuid,
  '(a):服務人員 Y 自己呼叫同一支函式,拿到的是指向 Y 自己的綁定碼(auth.uid() 解析按人區分)'
);

-- 已離職(status <> 'active')。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000005');
select throws_ok(
  $$select generate_own_staff_line_binding_code('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(a):已離職(status=removed)的服務人員不能產生綁定碼'
);
select pg_temp.test_clear_auth();

-- 未開通登入(login_status <> 'active')。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000006');
select throws_ok(
  $$select generate_own_staff_line_binding_code('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(a):還沒開通登入(login_status=invited)的服務人員不能產生綁定碼'
);
select pg_temp.test_clear_auth();

-- 完全不屬於這間商家的人。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000008');
select throws_ok(
  $$select generate_own_staff_line_binding_code('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(a):完全不屬於這間商家的登入者不能產生綁定碼(帶別人的 merchant_id 也沒用)'
);
select pg_temp.test_clear_auth();

-- 同商家的客服(不是服務人員)—— 這支函式只認 merchant_staff,客服有自己的 3.5。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000002');
select throws_ok(
  $$select generate_own_staff_line_binding_code('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(a):同商家的在職客服呼叫這支「服務人員專用」函式也被擋下(客服走自己的 3.5,兩條路不混用)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ② (b) unbind_line_account 的 staff 分支:管理員「或本人」+ 管理員路徑迴歸保護。
-- =========================================================================
-- 先讓服務人員 X 真的綁定成功(走正式路徑:service_role 消費綁定碼,規則 2.8/2.9)。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001', 'service_role');
select (consume_line_binding_code(:'xcode1_code', 'ef000000-0000-4000-8000-000000000021', 'Um11dStaffX0001')->>'success')::boolean as ok1 \gset consume1_
select pg_temp.test_clear_auth();

select is(
  (select row(line_bound, line_user_id)::text from merchant_staff where id = 'ef000000-0000-4000-8000-000000000041'),
  row(true, 'Um11dStaffX0001')::text,
  '(b) 前置:服務人員 X 自己產生的綁定碼被 Webhook 消費後,line_bound/line_user_id 正確寫入'
);

-- 本人以外的服務人員不能解除。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000004'); -- 服務人員 Y
select throws_ok(
  $$select unbind_line_account('staff', 'ef000000-0000-4000-8000-000000000041')$$,
  '42501', null,
  '(b) 核心必測:服務人員 Y 不能解除服務人員 X 的綁定(「本人」是用 auth.uid() 對照 user_id 判斷,不是信任前端傳的 id)'
);
select pg_temp.test_clear_auth();

-- 迴歸:客服原本就不能解除服務人員的綁定,放寬之後仍然不能(客服不是管理員、也不是本人)。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000002');
select throws_ok(
  $$select unbind_line_account('staff', 'ef000000-0000-4000-8000-000000000041')$$,
  '42501', null,
  '(b) 迴歸:在職客服仍然不能解除服務人員的 LINE 綁定(這次放寬的是「本人」,不是「所有同事」)'
);
select pg_temp.test_clear_auth();

-- 本人可以解除。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000003');
select lives_ok(
  $$select unbind_line_account('staff', 'ef000000-0000-4000-8000-000000000041')$$,
  '(b) 核心必測:服務人員 X 可以解除自己的 LINE 綁定(2026-09-24 使用者裁決的主體)'
);
select pg_temp.test_clear_auth();

select is(
  (select row(line_user_id, line_bound)::text from merchant_staff where id = 'ef000000-0000-4000-8000-000000000041'),
  row(null, false)::text,
  '(b)/規則 2.9:本人解除時同樣走 bypass 旗標路徑,line_user_id 與 line_bound 都正確清空(卡片顯示的就是 line_bound)'
);

-- 迴歸:管理員原本能做的兩件事都還能做。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001');
select code from generate_staff_line_binding_code('ef000000-0000-4000-8000-000000000041') \gset admincode1_
select pg_temp.test_clear_auth();

select ok(
  :'admincode1_code' ~ '^[0-9]{6}$',
  '(b) 迴歸:商家管理員仍然可以幫服務人員產生綁定碼(3.6 完全沒有被這次放寬影響)'
);

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001', 'service_role');
select (consume_line_binding_code(:'admincode1_code', 'ef000000-0000-4000-8000-000000000021', 'Um11dStaffX0002')->>'success')::boolean as ok2 \gset consume2_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001');
select lives_ok(
  $$select unbind_line_account('staff', 'ef000000-0000-4000-8000-000000000041')$$,
  '(b) 迴歸:商家管理員仍然可以解除服務人員的 LINE 綁定'
);
select pg_temp.test_clear_auth();

select is(
  (select row(line_user_id, line_bound)::text from merchant_staff where id = 'ef000000-0000-4000-8000-000000000041'),
  row(null, false)::text,
  '(b) 迴歸:管理員解除後欄位同樣正確清空'
);

-- 迴歸:3.4 admin 自助產生綁定碼不受影響。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001');
select code from generate_own_admin_line_binding_code('ef000000-0000-4000-8000-000000000021') \gset adminown1_
select pg_temp.test_clear_auth();

select ok(
  :'adminown1_code' ~ '^[0-9]{6}$',
  '(b) 迴歸:3.4 generate_own_admin_line_binding_code 不受影響'
);

-- 迴歸:客服本人解除自己的綁定。先真的綁起來,才驗得出「欄位有被清空」而不只是「沒拋錯」。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000002');
select code from generate_own_agent_line_binding_code('ef000000-0000-4000-8000-000000000021') \gset agentown1_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001', 'service_role');
select (consume_line_binding_code(:'agentown1_code', 'ef000000-0000-4000-8000-000000000021', 'Um11dAgent0001')->>'success')::boolean as ok3 \gset consume3_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000002');
select lives_ok(
  $$select unbind_line_account('agent', 'ef000000-0000-4000-8000-000000000051')$$,
  '(b) 迴歸:客服本人仍然可以解除自己的綁定(agent 分支的「本人」路徑沒有被三值邏輯修補弄壞)'
);
select pg_temp.test_clear_auth();

select is(
  (select row(line_user_id, line_bound)::text from merchant_agents where id = 'ef000000-0000-4000-8000-000000000051'),
  row(null, false)::text,
  '(b) 迴歸:客服本人解除後欄位正確清空(不是只有「沒拋錯」而已)'
);

-- =========================================================================
-- ⑤ 2026-09-24 順帶修掉的既有三值邏輯漏洞(admin / agent 兩個分支)。
--
-- 漏洞本體:原本寫 `if not (private.is_merchant_admin(...) or v_self_user_id = auth.uid())`。
-- 當那一列的 user_id 是 NULL 時,`NULL = <呼叫者 uuid>` 是 NULL,`not (false or NULL)` 是 NULL,
-- 而 `if NULL then` 不成立 ⇒ raise 不會執行,直接掉到下面那行 UPDATE。
--
-- ⚠️ 所以這一段每個情境都斷言**兩件事**:(1) 有正確拋出 42501、(2) 資料真的沒有被改動。
--    只斷言 throws_ok 是不夠的 —— 漏洞的症狀恰恰是「raise 沒觸發,但 UPDATE 執行了」,
--    如果修補寫錯成「raise 有拋但 UPDATE 也跑了」之類的情況,只看 throws_ok 會漏掉。
-- =========================================================================

-- 把「已邀請未註冊」的客服(user_id = NULL)設成已綁定狀態。
-- 不能走 generate_own_agent_line_binding_code(那支要求 user_id = auth.uid(),NULL 永遠不成立),
-- 也沒有任何「管理員幫客服產生綁定碼」的函式(3.4/3.5 都是自助),所以直接寫欄位。
-- merchant_agents 上沒有 line 欄位保護觸發器(只有 merchant_staff 有,規則 2.9),
-- 以 postgres 身分直接 update 是這份 fixture 唯一可行的方式。
update merchant_agents
set line_user_id = 'Um11dPendingAgent001', line_bound = true
where id = 'ef000000-0000-4000-8000-000000000052';

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000008'); -- 路人(任何已登入者)
select throws_ok(
  $$select unbind_line_account('agent', 'ef000000-0000-4000-8000-000000000052')$$,
  '42501', null,
  '⑤ 核心必測(漏洞本體):路人不能解除「user_id 為 NULL」的客服的 LINE 綁定 —— 修補前 not (false or NULL) = NULL 會讓權限檢查被靜默跳過'
);
select pg_temp.test_clear_auth();

select is(
  (select row(line_user_id, line_bound)::text from merchant_agents where id = 'ef000000-0000-4000-8000-000000000052'),
  row('Um11dPendingAgent001', true)::text,
  '⑤ 核心必測(漏洞本體):被擋下之後那一列完全沒有被改動(證明 UPDATE 真的沒有執行到)'
);

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000008'); -- 路人,對 admin 分支
select throws_ok(
  $$select unbind_line_account('admin', 'ef000000-0000-4000-8000-000000000061')$$,
  '42501', null,
  '⑤ admin 分支:路人不能解除管理員的 LINE 綁定(merchant_admins.user_id 目前是 NOT NULL 所以現在不可能觸發那個洞,但行為要先釘住,免得將來某支 migration 放寬 NOT NULL 時無聲打開)'
);
select pg_temp.test_clear_auth();

select is(
  (select line_bound from merchant_admins where id = 'ef000000-0000-4000-8000-000000000061'),
  false,
  '⑤ admin 分支:被擋下之後管理員那一列的 line_bound 維持原狀(本測試沒有幫他綁定,所以原狀就是 false)'
);

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001'); -- 商家管理員
select lives_ok(
  $$select unbind_line_account('agent', 'ef000000-0000-4000-8000-000000000052')$$,
  '⑤ 迴歸:商家管理員仍然可以解除任何一位客服的綁定,包含 user_id 為 NULL 的那一筆(修補沒有把管理員路徑弄壞)'
);
select pg_temp.test_clear_auth();

select is(
  (select row(line_user_id, line_bound)::text from merchant_agents where id = 'ef000000-0000-4000-8000-000000000052'),
  row(null, false)::text,
  '⑤ 迴歸:管理員解除後欄位正確清空'
);

-- =========================================================================
-- ③ (c) get_merchant_line_bot_public_info —— 誰能呼叫、以及「真的只回傳公開資訊」。
-- =========================================================================
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000001');
select get_merchant_line_bot_public_info('ef000000-0000-4000-8000-000000000021')::text as info \gset adminpub_
select pg_temp.test_clear_auth();

select is(
  ((:'adminpub_info')::jsonb ->> 'is_connected')::boolean,
  true,
  '(c):已完成串接的商家,is_connected 回傳 true'
);

select is(
  (:'adminpub_info')::jsonb ->> 'line_bot_basic_id',
  'm11dshop',
  '(c):回傳 line_bot_basic_id(前端組加好友連結 https://line.me/R/ti/p/@<basic_id> 的唯一來源)'
);

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000002');
select lives_ok(
  $$select get_merchant_line_bot_public_info('ef000000-0000-4000-8000-000000000021')$$,
  '(c):在職客服可以呼叫(修掉「客服拿不到加好友連結」的既有 bug —— 之前只能打管理員專用的 get_merchant_line_config_status,必定 42501)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000003');
select lives_ok(
  $$select get_merchant_line_bot_public_info('ef000000-0000-4000-8000-000000000021')$$,
  '(c):在職且已開通登入的服務人員可以呼叫'
);
select pg_temp.test_clear_auth();

select is(
  (select array_agg(t.k order by t.k) from jsonb_object_keys((:'adminpub_info')::jsonb) as t(k)),
  array['display_name', 'is_connected', 'line_bot_basic_id'],
  '(c) 核心必測:回傳的 JSON 就只有這三個 key,沒有多餘欄位'
);

select ok(
  not ((:'adminpub_info')::jsonb ? 'channel_secret')
  and not ((:'adminpub_info')::jsonb ? 'channel_access_token')
  and not ((:'adminpub_info')::jsonb ? 'channel_access_token_masked')
  and not ((:'adminpub_info')::jsonb ? 'channel_id')
  and not ((:'adminpub_info')::jsonb ? 'line_bot_user_id')
  and not ((:'adminpub_info')::jsonb ? 'last_tested_at')
  and not ((:'adminpub_info')::jsonb ? 'last_test_result')
  and (:'adminpub_info') not like '%must-never-leak%',
  '(c) 核心必測:回傳內容不含任何憑證欄位或串接排查資訊(逐一點名,並且整段 JSON 文字裡找不到憑證的內容)'
);

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000008');
select throws_ok(
  $$select get_merchant_line_bot_public_info('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(c):完全不屬於這間商家的登入者被擋下'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000005');
select throws_ok(
  $$select get_merchant_line_bot_public_info('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(c):已離職的服務人員被擋下(private.is_merchant_staff 內含 status=active)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000006');
select throws_ok(
  $$select get_merchant_line_bot_public_info('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(c):還沒開通登入的服務人員被擋下(private.is_merchant_staff 內含 login_status=active)'
);
select pg_temp.test_clear_auth();

-- B 店完全沒有 merchant_line_configs 那一列 → 回傳「尚未串接」的預設物件,不拋錯
-- (行為比照既有 3.2,讓前端只要處理一種形狀)。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000007');
select get_merchant_line_bot_public_info('ef000000-0000-4000-8000-000000000022')::text as info \gset bpub_
select pg_temp.test_clear_auth();

select is(
  (:'bpub_info')::jsonb,
  -- null 一律加明確的 ::text 轉型:jsonb_build_object 是 variadic "any",傳裸露的 NULL 字面值
  -- 依賴型別推導,加上轉型讓這一行不管在哪個 PostgreSQL 版本都不會有「無法決定多型型別」的風險。
  -- 兩種寫法產生的 JSON 值完全相同(都是 JSON null)。
  jsonb_build_object('is_connected', false, 'display_name', null::text, 'line_bot_basic_id', null::text),
  '(c):尚未串接的商家回傳 is_connected=false 的預設物件,而不是拋錯(前端用這個判斷「不要顯示產生綁定碼按鈕」)'
);

-- 釘住「這次刻意沒有放寬 get_merchant_line_config_status」。
select pg_temp.test_set_auth('ef000000-0000-4000-8000-000000000003');
select throws_ok(
  $$select get_merchant_line_config_status('ef000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '(c) 設計意圖釘死:get_merchant_line_config_status 維持「管理員專用」,服務人員呼叫仍然被擋 —— 我們走的是新增窄函式,不是放寬既有的管理員函式'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
