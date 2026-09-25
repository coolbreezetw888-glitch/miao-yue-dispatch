-- SPECS-INDEX #798(規格書 .project/specs/客服編輯功能.md #798;2026-09-25 使用者裁決「選 A+C」):
-- 客服「真正刪除」public.hard_delete_merchant_agent(uuid) 的核心必測。
-- 對應 migration:20260925040001_hard_delete_merchant_agent.sql。
--
-- 【主腦交辦時點名一定要測到的三件事】
--   (a) 非管理員呼叫會失敗(同店客服 / 別店管理員 都是 42501)
--   (b) authenticated 不能繞過函式直接 DELETE(merchant_agents 沒有 DELETE policy,直接 delete 會是 0 列)
--   (c) 刪掉之後真的查不到(而且 merchant_agent_permissions 也一起 cascade 掉、auth.users 不受影響)
--
-- 【外鍵盤點(2026-09-25 實查正式庫 pg_constraint)】
-- 指向 merchant_agents.id 的外鍵只有 merchant_agent_permissions.agent_id(on delete cascade),
-- 所以 ⑤ 專門驗「權限列真的跟著消失」——並且先用前提斷言證明刪除前權限列 > 0,不對空集合斷言 0。
--
-- 寫法比照 module3_02_hard_delete_merchant_staff.sql(服務人員硬刪除的既有測試)。
begin;

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
--   商家 A:管理員 admin_a;客服 X1(active,①測「未移除不能刪」)、X2(removed,掛 2 列權限,
--           ⑤測「真的刪得掉、權限 cascade、auth.users 不動」)、X3(removed,②③④專門測「被擋下
--           後完全不受影響」,從頭到尾不會真的被刪)、X4(active,當「非管理員的呼叫者」)
--   商家 B:管理員 admin_b(局外人);客服 XB(removed,⑥驗跨商家隔離)
-- =========================================================================
insert into auth.users (id, email) values
  ('a3060000-0000-4000-8000-000000000001', 'pgtap-m306-admin-a@test.local'),
  ('a3060000-0000-4000-8000-000000000002', 'pgtap-m306-admin-b@test.local'),
  ('a3060000-0000-4000-8000-000000000011', 'pgtap-m306-agent-x1@test.local'),
  ('a3060000-0000-4000-8000-000000000012', 'pgtap-m306-agent-x2@test.local'),
  ('a3060000-0000-4000-8000-000000000013', 'pgtap-m306-agent-x3@test.local'),
  ('a3060000-0000-4000-8000-000000000014', 'pgtap-m306-agent-x4@test.local'),
  ('a3060000-0000-4000-8000-000000000015', 'pgtap-m306-agent-xb@test.local');

insert into groups (id) values
  ('a3060000-0000-4000-8000-000000000010'),
  ('a3060000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('a3060000-0000-4000-8000-000000000020', 'a3060000-0000-4000-8000-000000000010', '客服硬刪除測試A店', 'in_store_beauty'),
  ('a3060000-0000-4000-8000-000000000021', 'a3060000-0000-4000-8000-000000000011', '客服硬刪除測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('a3060000-0000-4000-8000-000000000020', 'a3060000-0000-4000-8000-000000000001'),
  ('a3060000-0000-4000-8000-000000000021', 'a3060000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status, activated_at) values
  ('a3060000-0000-4000-8000-000000000031', 'a3060000-0000-4000-8000-000000000020', 'a3060000-0000-4000-8000-000000000011', 'X1-在職', '0900003061', 'pgtap-m306-agent-x1@test.local', 'active', now()),
  ('a3060000-0000-4000-8000-000000000032', 'a3060000-0000-4000-8000-000000000020', 'a3060000-0000-4000-8000-000000000012', 'X2-已移除可刪', '0900003062', 'pgtap-m306-agent-x2@test.local', 'removed', now()),
  ('a3060000-0000-4000-8000-000000000033', 'a3060000-0000-4000-8000-000000000020', 'a3060000-0000-4000-8000-000000000013', 'X3-已移除只測擋下', '0900003063', 'pgtap-m306-agent-x3@test.local', 'removed', now()),
  ('a3060000-0000-4000-8000-000000000034', 'a3060000-0000-4000-8000-000000000020', 'a3060000-0000-4000-8000-000000000014', 'X4-在職非管理員呼叫者', '0900003064', 'pgtap-m306-agent-x4@test.local', 'active', now()),
  ('a3060000-0000-4000-8000-000000000035', 'a3060000-0000-4000-8000-000000000021', 'a3060000-0000-4000-8000-000000000015', 'XB-B店已移除', '0900003065', 'pgtap-m306-agent-xb@test.local', 'removed', now());

-- X2 掛 2 列權限設定(⑤ 驗 cascade 用)。
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('a3060000-0000-4000-8000-000000000032', 'orders', true),
  ('a3060000-0000-4000-8000-000000000032', 'members', true);

-- =========================================================================
-- ⓪ 函式存在,而且 EXECUTE 權限收得對(supabase-permission-hygiene 規則 1:
--    drop/create 會繼承 PUBLIC EXECUTE,所以 public / anon 一定要驗到是「不能」)。
-- =========================================================================
select has_function('public', 'hard_delete_merchant_agent', array['uuid'],
  '⓪:public.hard_delete_merchant_agent(uuid) 存在');

select ok(
  not has_function_privilege('public', 'public.hard_delete_merchant_agent(uuid)', 'execute'),
  '⓪:PUBLIC 不能執行 hard_delete_merchant_agent(新函式預設會繼承 PUBLIC EXECUTE,必須 revoke)'
);
select ok(
  not has_function_privilege('anon', 'public.hard_delete_merchant_agent(uuid)', 'execute'),
  '⓪:anon 不能執行 hard_delete_merchant_agent'
);
select ok(
  has_function_privilege('authenticated', 'public.hard_delete_merchant_agent(uuid)', 'execute'),
  '⓪:authenticated 可以執行 hard_delete_merchant_agent(前端商家管理員就是用這個角色呼叫;授權判斷在函式內部)'
);

-- =========================================================================
-- ① 商家 A 管理員對 status=active 的 X1 呼叫 → P0001 擋下,不能跳過軟移除。
-- =========================================================================
select pg_temp.test_set_auth('a3060000-0000-4000-8000-000000000001');
select throws_ok(
  $$select hard_delete_merchant_agent('a3060000-0000-4000-8000-000000000031')$$,
  'P0001', NULL,
  '①:對 status=active 的客服呼叫 hard_delete_merchant_agent 被擋下(errcode P0001,必須先軟移除)'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_agents where id = 'a3060000-0000-4000-8000-000000000031'),
  1,
  '①:X1 完全不受影響,資料還在'
);

-- =========================================================================
-- ② 同一間店的客服 X4(非管理員)對已移除的 X3 呼叫 → 42501。
-- =========================================================================
select pg_temp.test_set_auth('a3060000-0000-4000-8000-000000000014');
select throws_ok(
  $$select hard_delete_merchant_agent('a3060000-0000-4000-8000-000000000033')$$,
  '42501', NULL,
  '②:同店客服(非商家管理員)呼叫被 403(42501)擋下'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_agents where id = 'a3060000-0000-4000-8000-000000000033'),
  1,
  '②:客服呼叫被擋下後,X3 完全不受影響'
);

-- =========================================================================
-- ③ 商家 B 的管理員對商家 A 的 X3 呼叫 → 42501(跨商家)。
-- =========================================================================
select pg_temp.test_set_auth('a3060000-0000-4000-8000-000000000002');
select throws_ok(
  $$select hard_delete_merchant_agent('a3060000-0000-4000-8000-000000000033')$$,
  '42501', NULL,
  '③:其他商家的管理員呼叫被 403(42501)擋下'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_agents where id = 'a3060000-0000-4000-8000-000000000033'),
  1,
  '③:其他商家管理員呼叫被擋下後,X3 依然完全不受影響'
);

-- =========================================================================
-- ④ authenticated 不能繞過函式直接 DELETE / UPDATE merchant_agents。
--    merchant_agents 對 authenticated 只有 SELECT policy(security_audit_05 在守這件事),
--    表層雖然有 DELETE / UPDATE 的 grant,但 RLS 沒有對應 policy ⇒ 語句本身不會報錯,只是
--    影響 0 列。所以這裡的斷言不是 throws_ok,而是「執行得過、但資料一根毛都沒少」。
--    呼叫者故意用商家 A 管理員——就算是管理員,也不能繞過函式直接砍表。
-- =========================================================================
select pg_temp.test_set_auth('a3060000-0000-4000-8000-000000000001');
select lives_ok(
  $$delete from public.merchant_agents where id = 'a3060000-0000-4000-8000-000000000033'$$,
  '④:authenticated 直接 delete merchant_agents 不會報錯(表層 grant 存在)……'
);
select lives_ok(
  $$update public.merchant_agents set name = '被直接改掉' where id = 'a3060000-0000-4000-8000-000000000033'$$,
  '④:authenticated 直接 update merchant_agents 也不會報錯……'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_agents where id = 'a3060000-0000-4000-8000-000000000033'),
  1,
  '④:……但直接 delete 影響 0 列,X3 還在(RLS 沒有 DELETE policy,只能走 hard_delete_merchant_agent)'
);
select is(
  (select name from merchant_agents where id = 'a3060000-0000-4000-8000-000000000033'),
  'X3-已移除只測擋下',
  '④:……直接 update 也影響 0 列,X3 的姓名沒被改掉(RLS 沒有 UPDATE policy)'
);

-- =========================================================================
-- ⑤ 商家 A 管理員對已移除的 X2 呼叫 → 成功,列消失、權限列 cascade 消失、auth.users 不動。
-- =========================================================================
-- 前提:刪除前 X2 真的有 2 列權限(否則底下「權限列 = 0」是對空集合斷言,假通過)。
select is(
  (select count(*)::int from merchant_agent_permissions where agent_id = 'a3060000-0000-4000-8000-000000000032'),
  2,
  '⑤(前提):刪除前 X2 掛著 2 列 merchant_agent_permissions'
);

select pg_temp.test_set_auth('a3060000-0000-4000-8000-000000000001');
select lives_ok(
  $$select hard_delete_merchant_agent('a3060000-0000-4000-8000-000000000032')$$,
  '⑤:商家管理員對已移除的 X2 呼叫 hard_delete_merchant_agent 成功'
);
select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from merchant_agents where id = 'a3060000-0000-4000-8000-000000000032'),
  0,
  '⑤:X2 真的從 merchant_agents 消失了(硬刪除,不是改 status)'
);
select is(
  (select count(*)::int from merchant_agent_permissions where agent_id = 'a3060000-0000-4000-8000-000000000032'),
  0,
  '⑤:X2 的 merchant_agent_permissions 透過 on delete cascade 一併清掉(唯一一條指向 merchant_agents 的外鍵)'
);
-- auth.users 沒有開放給 authenticated 直接 SELECT,這裡是 postgres 身份查,純粹確認結論本身。
select is(
  (select count(*)::int from auth.users where id = 'a3060000-0000-4000-8000-000000000012'),
  1,
  '⑤:X2 原本綁定的 auth.users 帳號完全不受影響(完全不動 auth.users)'
);
-- 刪掉之後 (merchant_id, user_id) 的 partial unique index 釋放了,同一個人可以被重新邀請。
select lives_ok(
  $$insert into merchant_agents (merchant_id, user_id, name, phone, invited_email, status)
    values ('a3060000-0000-4000-8000-000000000020', 'a3060000-0000-4000-8000-000000000012', 'X2-重新邀請', '0900003062', 'pgtap-m306-agent-x2@test.local', 'invited')$$,
  '⑤:硬刪除之後,同一個 (商家, 登入帳號) 可以重新建立客服紀錄(unique index 已釋放)'
);

-- =========================================================================
-- ⑥ 其他資料完全不受影響:商家 A 剩下 X1 / X3 / X4 / 重新邀請的 X2 共 4 列;商家 B 的 XB 還在。
-- =========================================================================
select is(
  (select count(*)::int from merchant_agents where merchant_id = 'a3060000-0000-4000-8000-000000000020'),
  4,
  '⑥:商家 A 底下其餘客服(X1 / X3 / X4 + ⑤ 重新邀請的那一列)完全不受影響'
);
select is(
  (select count(*)::int from merchant_agents where id = 'a3060000-0000-4000-8000-000000000035'),
  1,
  '⑥:商家 B 的客服 XB 完全不受影響'
);

-- =========================================================================
-- ⑦ 找不到的 id → P0001。
-- =========================================================================
select pg_temp.test_set_auth('a3060000-0000-4000-8000-000000000001');
select throws_ok(
  $$select hard_delete_merchant_agent('a3060000-0000-4000-8000-0000000000ff')$$,
  'P0001', NULL,
  '⑦:對不存在的 agent id 呼叫 → P0001「找不到指定的客服紀錄」'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧ 補一條給 #796:已廢棄的 update_my_agent_profile 已經不存在(絆線,防止有人加回來)。
--    放在這裡而不是另開一支檔案,是因為它跟這批 migration(20260925040000)同一批套用。
-- =========================================================================
select hasnt_function('public', 'update_my_agent_profile', array['uuid', 'text', 'text'],
  '#796:public.update_my_agent_profile(uuid,text,text) 已經被 20260925040000 移除,不存在(功能由 update_merchant_agent 完全涵蓋,不要加回來)');

select * from finish();

rollback;
