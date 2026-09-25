-- 跨模組修正批次「首頁外殼與主題色優化」1.3/驗收四.2 要求的必測項目:
-- 本人可以更新自己的姓名/職位;呼叫時帶別人的 merchant_id/嘗試更新別人的列會被擋下
-- (找不到符合條件的列,不會誤改到別人)。
--
-- 對應 supabase/migrations/20260916170000_homepage_shell_profile_fields.sql 的
-- update_my_admin_profile() / update_my_agent_profile()。
--
-- ⚠️ 2026-09-25(SPECS-INDEX #796,migration 20260925040000):update_my_agent_profile 已經被移除。
--    它能做的事(客服改自己的 nickname / job_title)在 2026-09-24 起被 update_merchant_agent 的
--    「本人」授權路徑完全涵蓋(pgTAP 見 module3_05_agent_update_and_restore.sql),前端也早已不再呼叫。
--    原本這份檔案 ② 那一段(4 條)+ ③ 的 anon 斷言(1 條)是在測那支函式,現在改成一條
--    hasnt_function 絆線(防止有人把它加回來),plan 從 12 變成 7(拿掉 6 條、加 1 條)。
--    客服那兩列 fixture 保留不動——刪掉沒有好處,留著也沒有副作用。
begin;

select plan(7);

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

-- ---------------------------------------------------------------------------
-- fixture:兩個商家(不同集團),M1 有兩位管理員+兩位客服,M2 只是用來測試
-- 「帶別人商家的 merchant_id」時會不會被擋下,呼叫者在 M2 完全沒有任何紀錄。
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('a3000000-0000-4000-8000-000000000001', 'pgtap-admin-a@test.local'),
  ('a3000000-0000-4000-8000-000000000002', 'pgtap-admin-b@test.local'),
  ('a3000000-0000-4000-8000-000000000003', 'pgtap-agent-a@test.local'),
  ('a3000000-0000-4000-8000-000000000004', 'pgtap-agent-b@test.local');

insert into groups (id) values
  ('a3000000-0000-4000-8000-000000000010'),
  ('a3000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type)
values
  ('a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000010', '個人資料測試商家 M1', 'on_site_dispatch'),
  ('a3000000-0000-4000-8000-000000000021', 'a3000000-0000-4000-8000-000000000011', '個人資料測試商家 M2', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id)
values
  ('a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone)
values
  ('a3000000-0000-4000-8000-000000000030', 'a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000003', 'pgTAP 客服 A', 'pgtap-agent-a@test.local', 'active', now(), '0900000101'),
  ('a3000000-0000-4000-8000-000000000031', 'a3000000-0000-4000-8000-000000000020', 'a3000000-0000-4000-8000-000000000004', 'pgTAP 客服 B', 'pgtap-agent-b@test.local', 'active', now(), '0900000102');

-- ---------------------------------------------------------------------------
-- ① 管理員 A 更新自己的姓名/職位,應該成功。
-- ---------------------------------------------------------------------------
select pg_temp.test_set_auth('a3000000-0000-4000-8000-000000000001');

select lives_ok(
  -- ⚠️ 2026-09-24(migration 20260924040600):update_my_admin_profile 追加了 p_phone
  --    參數(使用者裁決:平台方需要能掌握每一位商家管理員的聯絡方式),舊的 3 參數重載已經被
  --    drop(避免 PostgREST 解析到不寫 phone 的舊版),所以這裡必須改成 4 個參數。
  --    這一條測的是「本人可以更新自己的資料」,語意完全沒變。
  -- ⚠️ 開發過程中曾短暫有過一個 5 參數版本(多一個 p_contact_email),同日被使用者推翻
  --    (「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」),那個簽章也已經
  --    一併 drop。這裡是 4 個參數,不是 5 個。
  $$select update_my_admin_profile('a3000000-0000-4000-8000-000000000020', '管理員 A 姓名', '店長', null)$$,
  '管理員 A 可以成功更新自己在 M1 的 display_name/job_title'
);

select is(
  (select display_name from merchant_admins
   where merchant_id = 'a3000000-0000-4000-8000-000000000020' and user_id = 'a3000000-0000-4000-8000-000000000001'),
  '管理員 A 姓名',
  '管理員 A 自己的 display_name 確實被更新'
);

select is(
  (select job_title from merchant_admins
   where merchant_id = 'a3000000-0000-4000-8000-000000000020' and user_id = 'a3000000-0000-4000-8000-000000000001'),
  '店長',
  '管理員 A 自己的 job_title 確實被更新'
);

-- 隔離檢查:管理員 B(同一間商家)的資料完全沒被動到。
select is(
  (select display_name from merchant_admins
   where merchant_id = 'a3000000-0000-4000-8000-000000000020' and user_id = 'a3000000-0000-4000-8000-000000000002'),
  null,
  '管理員 A 更新自己的資料,不會影響到同一間商家另一位管理員 B 的 display_name'
);

-- 帶別人的 merchant_id(M2,管理員 A 在這間店完全沒有 merchant_admins 紀錄):找不到符合條件的列,
-- 應該拋出例外,不會誤改到任何資料。
select throws_ok(
  $$select update_my_admin_profile('a3000000-0000-4000-8000-000000000021', '竄改姓名', '竄改職位', null)$$,
  'P0002',
  NULL,
  '管理員 A 帶別人商家(M2)的 merchant_id 呼叫時,找不到符合條件的列,直接被擋下'
);

select pg_temp.test_clear_auth();

-- ---------------------------------------------------------------------------
-- ② (2026-09-25,#796)客服自助改暱稱/職位的舊函式 update_my_agent_profile 已移除。
--    原本這裡 4 條斷言在測它;現在改成一條絆線:它必須「不存在」。
--    客服自助編輯的行為測試在 module3_05_agent_update_and_restore.sql(走 update_merchant_agent 的
--    「本人」授權路徑),不在這裡重複。
-- ---------------------------------------------------------------------------
select hasnt_function('public', 'update_my_agent_profile', array['uuid', 'text', 'text'],
  '#796:public.update_my_agent_profile(uuid,text,text) 已由 20260925040000 移除,不得再存在(同一個欄位兩個寫入入口、兩套授權判斷,是隱性的不一致來源;要改客服資料一律走 update_merchant_agent)');

-- ---------------------------------------------------------------------------
-- ③ 權限邊界:anon 不能呼叫 update_my_admin_profile(比照既有 RPC 的 revoke 檢查方式)。
--    (update_my_agent_profile 那一條在 #796 隨函式一起移除——函式不存在時
--     has_function_privilege 會直接 raise,見下方說明。)
--
-- ⚠️ 2026-09-24 修正(主腦跑 pgTAP 時抓到,整個測試套件因此 FAIL):這裡原本寫成
--    `(uuid, text, text, text, text)`(5 個參數),那是 20260924040600 開發過程中曾經存在、
--    但**從未上線**的草稿簽章(含 p_contact_email)。使用者同日裁決三種「人」的角色只留一個
--    Email,那個草稿被改成只加 phone,函式最終是 **4 個參數** (uuid, text, text, text)。
--
--    為什麼這個錯誤特別難查:`has_function_privilege()` 在函式不存在時**不是回傳 false,
--    而是直接 raise**(`function ... does not exist`),所以整支測試腳本會在這裡中斷、
--    後面的斷言完全不執行。pgTAP 的回報是「planned 12 but ran 10 / Failed: 0」——
--    看起來像「少跑兩條」而不是「有東西壞了」,很容易被誤判成 plan() 數字寫錯而把 12 改成 10,
--    那樣就會把兩條真正的權限邊界斷言默默丟掉。**不要那樣修。**
-- ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.update_my_admin_profile(uuid, text, text, text)', 'execute'),
  'anon 角色不能執行 update_my_admin_profile'
);

select * from finish();

rollback;
