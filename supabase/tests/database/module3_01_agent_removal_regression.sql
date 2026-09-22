-- 模組 3 規則 2.9 回歸測試(規格書要求必測的一條,見 ARCHITECTURE.md 第八節第 5 條)。
-- 移除客服後,用同一組(模擬)身份再次查詢,確認看不到該商家的任何資料,且
-- private.is_merchant_agent() 回傳 false。
--
-- 對應 supabase/migrations/20260916100000_staff_agent_schema.sql 的
-- private.is_merchant_agent()(必須包含 status = 'active' 條件)與
-- supabase/migrations/20260916100100_staff_agent_functions.sql 的 remove_merchant_agent()
-- (軟刪除,status 改成 removed)。
--
-- 2026-09-16 已依主腦/使用者要求,人工驗證過這份測試本身「真的抓得到 bug」,不是形式上永遠會過
-- 的假測試——驗證方式:暫時把 private.is_merchant_agent() 的 status='active' 條件拿掉
-- (等同重現「移除客服後,舊 session 還能繼續看到資料」的 bug),重新對本機測試資料庫套用這支
-- 改壞的函式後重跑這份測試,確認下面「移除後」那兩條斷言真的會 fail;改回正確版本後再重跑一次,
-- 確認全數轉為 pass。完整過程與指令記錄在 .claude/skills/automated-testing/SKILL.md。
begin;

select plan(5);

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

insert into auth.users (id, email) values
  ('a2000000-0000-4000-8000-000000000001', 'pgtap-merchant-admin@test.local'),
  ('a2000000-0000-4000-8000-000000000002', 'pgtap-agent@test.local');

insert into groups (id) values ('a2000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values (
  'a2000000-0000-4000-8000-000000000020',
  'a2000000-0000-4000-8000-000000000010',
  '客服移除測試商家',
  'on_site_dispatch'
);

insert into merchant_admins (merchant_id, user_id)
values ('a2000000-0000-4000-8000-000000000020', 'a2000000-0000-4000-8000-000000000001');

-- 直接插入一筆「已經是 active 客服」的紀錄(不透過 Edge Function 邀請流程,單純為了聚焦測試
-- is_merchant_agent / remove_merchant_agent 這兩支函式本身的行為)。
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone)
values (
  'a2000000-0000-4000-8000-000000000030',
  'a2000000-0000-4000-8000-000000000020',
  'a2000000-0000-4000-8000-000000000002',
  'pgTAP 測試客服',
  'pgtap-agent@test.local',
  'active',
  now(), '0900000101');

-- ① 移除前:以客服本人身份查詢,is_merchant_agent 應為 true,而且看得到這間商家。
select pg_temp.test_set_auth('a2000000-0000-4000-8000-000000000002');

select ok(
  private.is_merchant_agent('a2000000-0000-4000-8000-000000000020'),
  '移除前:private.is_merchant_agent() 回傳 true'
);

select is(
  (select count(*) from merchants where id = 'a2000000-0000-4000-8000-000000000020')::int,
  1,
  '移除前:客服可以透過 merchants_select RLS 政策看到自己被指派的商家'
);

select pg_temp.test_clear_auth();

-- ② 切換成商家管理員身份,執行移除。
select pg_temp.test_set_auth('a2000000-0000-4000-8000-000000000001');

select lives_ok(
  $$select remove_merchant_agent('a2000000-0000-4000-8000-000000000030')$$,
  '商家管理員可以成功移除這位客服'
);

select pg_temp.test_clear_auth();

-- ③ 移除後:換回「同一組」客服身份再次查詢,規則 2.9 要求的兩個關鍵斷言。
select pg_temp.test_set_auth('a2000000-0000-4000-8000-000000000002');

select ok(
  not private.is_merchant_agent('a2000000-0000-4000-8000-000000000020'),
  '移除後:private.is_merchant_agent() 回傳 false(規則 2.9 第 1 點)'
);

select is(
  (select count(*) from merchants where id = 'a2000000-0000-4000-8000-000000000020')::int,
  0,
  '移除後:同一組身份再次查詢,完全看不到該商家的任何資料(規則 2.9 核心要求)'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
