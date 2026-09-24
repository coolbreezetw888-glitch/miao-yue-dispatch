-- 安全回歸測試(2026-09-24 深夜巡檢批次 A3)。
-- 對應 migration:20260924020100_merchant_staff_identity_columns_guard.sql
--
-- 【為什麼需要這份測試】
-- merchant_staff_update 這條 RLS 政策是「整列」層級的,20260923050000 把它放寬給被授權
-- staff_management 的客服之後,客服就能把某位師傅的 user_id 改成自己的 auth uid,
-- 藉此讓 private.is_own_staff_row() 對他成立,拿到那位師傅的薪資/抽成/客戶個資,
-- 同時把本人踢出服務人員端。
--
-- 這份測試釘住三件事:
--   ① 負面:客服不能改 user_id / login_status(身分綁定,唯一的提權路徑);
--   ② 範圍回歸(重要):客服「仍然可以」做 2026-09-23 使用者決策明確授予的所有事情——
--      一般編輯、軟刪除(status='removed')、復職、改 compensation_type。
--      保護清單刻意不含這兩欄,這幾條測試就是防止以後有人把保護範圍又改寬;
--   ③ 正面:商家管理員可以改身分綁定欄位,而且系統自己的合法寫入路徑
--      (record_invited_staff_login / mark_staff_login_active_if_self /
--       update_my_staff_profile / hard_delete_merchant_staff)全部沒有被誤擋。
begin;

select plan(20);

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
--   01 = 商家管理員
--   02 = 被授權 staff_management 的客服(攻擊者,同時也是「範圍回歸」的主角)
--   03 = 服務人員甲(攻擊目標)的登入帳號
--   04 = 服務人員丙的登入帳號(用來測 mark_staff_login_active_if_self / update_my_staff_profile)
--   05 = 邀請流程要綁給服務人員丁的帳號
--   06 = 管理員把服務人員乙改綁過去的帳號
-- =========================================================================
insert into auth.users (id, email) values
  ('d2000000-0000-4000-8000-000000000001', 'pgtap-sec02-admin@test.local'),
  ('d2000000-0000-4000-8000-000000000002', 'pgtap-sec02-agent@test.local'),
  ('d2000000-0000-4000-8000-000000000003', 'pgtap-sec02-staff-a@test.local'),
  ('d2000000-0000-4000-8000-000000000004', 'pgtap-sec02-staff-c@test.local'),
  ('d2000000-0000-4000-8000-000000000005', 'pgtap-sec02-staff-d@test.local'),
  ('d2000000-0000-4000-8000-000000000006', 'pgtap-sec02-staff-b-new@test.local');

insert into groups (id) values ('d2000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('d2000000-0000-4000-8000-000000000020', 'd2000000-0000-4000-8000-000000000010', '服務人員身分欄位保護測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('d2000000-0000-4000-8000-000000000020', 'd2000000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone)
values ('d2000000-0000-4000-8000-000000000050', 'd2000000-0000-4000-8000-000000000020',
        'd2000000-0000-4000-8000-000000000002', '客服-服務人員管理', 'pgtap-sec02-agent@test.local',
        'active', now(), '0900000401');

insert into merchant_agent_permissions (agent_id, section_key, granted)
values ('d2000000-0000-4000-8000-000000000050', 'staff_management', true);

-- 甲:攻擊目標(已開通登入、在職、按件計酬)
insert into merchant_staff (id, merchant_id, name, phone, user_id, login_status, status, compensation_type)
values ('d2000000-0000-4000-8000-000000000040', 'd2000000-0000-4000-8000-000000000020', '服務人員甲', '0901000401',
        'd2000000-0000-4000-8000-000000000003', 'active', 'active', 'piece_rate');

-- 乙:給管理員做正面測試用
insert into merchant_staff (id, merchant_id, name, phone, login_status, status, compensation_type)
values ('d2000000-0000-4000-8000-000000000041', 'd2000000-0000-4000-8000-000000000020', '服務人員乙', '0901000402',
        'not_invited', 'active', 'piece_rate');

-- 丙:login_status='invited',用來測本人自助完成登入開通
insert into merchant_staff (id, merchant_id, name, phone, user_id, login_status, status)
values ('d2000000-0000-4000-8000-000000000042', 'd2000000-0000-4000-8000-000000000020', '服務人員丙', '0901000403',
        'd2000000-0000-4000-8000-000000000004', 'invited', 'active');

-- 丁:尚未邀請,用來測 Edge Function(service_role)的 record_invited_staff_login
insert into merchant_staff (id, merchant_id, name, phone, login_status, status)
values ('d2000000-0000-4000-8000-000000000043', 'd2000000-0000-4000-8000-000000000020', '服務人員丁', '0901000404',
        'not_invited', 'active');

-- 戊:已移除,用來測硬刪除(DELETE 路徑不該被 BEFORE UPDATE trigger 影響)
insert into merchant_staff (id, merchant_id, name, phone, status)
values ('d2000000-0000-4000-8000-000000000044', 'd2000000-0000-4000-8000-000000000020', '服務人員戊', '0901000405', 'removed');

-- 丙需要預設權限才能自助編輯個資(平常是 record_invited_staff_login 內部種入的)。
select public.seed_default_staff_permissions('d2000000-0000-4000-8000-000000000042');

-- =========================================================================
-- ①② 負面(核心):被授權 staff_management 的客服不能改身分綁定的兩個欄位。
--     同時比對錯誤碼與觸發器自己拋出的中文訊息,確保這兩條是被這支觸發器擋下的,
--     不是剛好撞到 RLS 的同一個 42501。
-- =========================================================================
select pg_temp.test_set_auth('d2000000-0000-4000-8000-000000000002');

select throws_ok(
  $$update merchant_staff
      set user_id = 'd2000000-0000-4000-8000-000000000002'
    where id = 'd2000000-0000-4000-8000-000000000040'$$,
  '42501', '只有商家管理員可以變更服務人員綁定的登入帳號或登入狀態',
  'A3 核心:客服不能把師傅的 user_id 改成自己(這就是原本的提權漏洞)'
);

select throws_ok(
  $$update merchant_staff set login_status = 'not_invited' where id = 'd2000000-0000-4000-8000-000000000040'$$,
  '42501', '只有商家管理員可以變更服務人員綁定的登入帳號或登入狀態',
  'A3 核心:客服不能改服務人員的登入狀態(login_status,跟 user_id 同一組身分綁定狀態)'
);

-- ③ 確認上面那幾次攻擊真的一個都沒有生效。
select is(
  (select user_id from merchant_staff where id = 'd2000000-0000-4000-8000-000000000040'),
  'd2000000-0000-4000-8000-000000000003'::uuid,
  'A3:攻擊全部被擋下,師傅甲的 user_id 依然是本人的帳號'
);

-- =========================================================================
-- ④~⑨ 範圍回歸(重要):保護清單刻意「只有」user_id / login_status。
--     客服在 2026-09-23 使用者決策下該有的能力一項都不能少——
--     一般編輯、軟刪除、復職、改計酬類型。
--     這幾條是用來擋住「以後有人順手把保護範圍改寬」的回歸保護。
-- =========================================================================
select lives_ok(
  $$update merchant_staff
      set phone = '0901000499', name = '服務人員甲(客服改名)', is_listed = true
    where id = 'd2000000-0000-4000-8000-000000000040'$$,
  'A3 範圍回歸:客服仍然可以做一般編輯(姓名/電話/上架狀態)'
);

select lives_ok(
  $$update merchant_staff set status = 'removed' where id = 'd2000000-0000-4000-8000-000000000040'$$,
  'A3 範圍回歸:客服仍然可以「軟刪除」服務人員(status=removed,使用者 2026-09-23 明確授予的功能)'
);

select is(
  (select status from merchant_staff where id = 'd2000000-0000-4000-8000-000000000040'),
  'removed',
  'A3 範圍回歸:軟刪除真的生效,不是被靜默擋下'
);

select lives_ok(
  $$update merchant_staff set status = 'active' where id = 'd2000000-0000-4000-8000-000000000040'$$,
  'A3 範圍回歸:客服仍然可以「復職」服務人員(status=active)'
);

select lives_ok(
  $$update merchant_staff set compensation_type = 'monthly_salary' where id = 'd2000000-0000-4000-8000-000000000040'$$,
  'A3 範圍回歸:客服仍然可以改計酬類型(compensation_type 不構成提權路徑,刻意不納入保護)'
);

select is(
  (select compensation_type from merchant_staff where id = 'd2000000-0000-4000-8000-000000000040'),
  'monthly_salary',
  'A3 範圍回歸:計酬類型的變更真的生效'
);

select pg_temp.test_clear_auth();

-- ⑩ 既有的薪資狀態歷史 AFTER 觸發器仍然正常運作(沒有被新的 BEFORE 觸發器連帶弄壞)。
-- 這一條刻意在 test_clear_auth() 之後(以 postgres 身分)查:staff_payroll_status_history
-- 沒有開給客服的 SELECT 政策,用客服身分查一定是空的,那會驗到錯的東西。
select ok(
  exists (
    select 1 from staff_payroll_status_history
    where staff_id = 'd2000000-0000-4000-8000-000000000040'
      and compensation_type = 'monthly_salary'
  ),
  'A3 回歸:客服改 compensation_type 之後,staff_payroll_status_history 照常記錄了新的區間'
);

-- =========================================================================
-- ⑪~⑭ 正面:商家管理員可以改身分綁定的兩個欄位。
-- =========================================================================
select pg_temp.test_set_auth('d2000000-0000-4000-8000-000000000001');

select lives_ok(
  $$update merchant_staff
      set user_id = 'd2000000-0000-4000-8000-000000000006'
    where id = 'd2000000-0000-4000-8000-000000000041'$$,
  'A3 正面:商家管理員可以變更服務人員綁定的登入帳號'
);

select is(
  (select user_id from merchant_staff where id = 'd2000000-0000-4000-8000-000000000041'),
  'd2000000-0000-4000-8000-000000000006'::uuid,
  'A3 正面:管理員的變更真的生效,不是被靜默擋下'
);

select lives_ok(
  $$update merchant_staff set login_status = 'invited' where id = 'd2000000-0000-4000-8000-000000000041'$$,
  'A3 正面:商家管理員可以變更 login_status'
);

-- ⑭ 硬刪除走的是 DELETE,BEFORE UPDATE 觸發器不該有任何影響。
select lives_ok(
  $$select public.hard_delete_merchant_staff('d2000000-0000-4000-8000-000000000044')$$,
  'A3 回歸:hard_delete_merchant_staff(DELETE 路徑)完全不受 BEFORE UPDATE 觸發器影響'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑮⑯ 合法路徑 1:mark_staff_login_active_if_self —— 服務人員本人(不是管理員)
--      完成邀請信設定密碼後,把自己的 login_status 從 invited 改成 active。
--      這條路徑靠 migration 裡補上的 transaction-local 旗標放行。
-- =========================================================================
select pg_temp.test_set_auth('d2000000-0000-4000-8000-000000000004');

select lives_ok(
  $$select public.mark_staff_login_active_if_self()$$,
  'A3 合法路徑:服務人員本人呼叫 mark_staff_login_active_if_self 沒有被觸發器擋下'
);

select is(
  (select login_status from merchant_staff where id = 'd2000000-0000-4000-8000-000000000042'),
  'active',
  'A3 合法路徑:login_status 真的從 invited 變成 active(旗標繞道確實生效)'
);

-- =========================================================================
-- ⑰ 合法路徑 2:update_my_staff_profile —— 服務人員自助編輯個資,
--    只碰 name/nickname/phone/avatar_url/intro,不該被擋。
--
-- ⚠️ 2026-09-24 使用者裁決:這支函式原本還有一個 p_contact_email(第 5 個參數),已連同
--    merchant_staff.contact_email 欄位本身一起移除(migration 20260924040800),所以這裡從
--    7 個參數改成 6 個。使用者原話:「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的
--    信箱)」「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
--    ⚠️ 這條斷言的證明力沒有變弱:它要證明的是「保護 trigger 不會誤擋服務人員自助編輯個資
--    這條合法路徑」,而它實際寫入的對照欄位是 **name 與 phone**(兩個都還存在、都真的可以編輯),
--    contact_email 在這裡本來就是傳 null、沒有被寫入,不是這條斷言的對照組。
--    真正列舉「一整排可編輯欄位」當對照組的是 security_audit_04 的 INSERT 範圍回歸那一條。
-- =========================================================================
select lives_ok(
  $$select public.update_my_staff_profile(
      'd2000000-0000-4000-8000-000000000042', '服務人員丙(自己改)', null, '0901000493', null, null)$$,
  'A3 合法路徑:服務人員自助編輯個資(update_my_staff_profile)沒有被誤擋'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑱⑲ 合法路徑 3:record_invited_staff_login —— Edge Function invite-merchant-staff
--      以 service_role 身份寫入 user_id/login_status,靠觸發器第一道
--      `auth.role() <> 'service_role'` 放行,不需要旗標。
-- =========================================================================
select pg_temp.test_set_auth('d2000000-0000-4000-8000-000000000001', 'service_role');

select lives_ok(
  $$select public.record_invited_staff_login(
      'd2000000-0000-4000-8000-000000000043',
      'd2000000-0000-4000-8000-000000000005',
      'pgtap-sec02-staff-d@test.local',
      'invited')$$,
  'A3 合法路徑:service_role 走 record_invited_staff_login 寫入 user_id/login_status 沒有被擋'
);

select is(
  (select user_id from merchant_staff where id = 'd2000000-0000-4000-8000-000000000043'),
  'd2000000-0000-4000-8000-000000000005'::uuid,
  'A3 合法路徑:邀請流程真的把 user_id 寫進去了'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑳ 觸發器本身存在(避免之後有人重建這張表或政策時整支掉了都沒人發現)。
-- =========================================================================
select ok(
  exists (
    select 1 from pg_trigger
    where tgrelid = 'public.merchant_staff'::regclass
      and tgname = 'merchant_staff_protect_identity_columns'
      and not tgisinternal
  ),
  'A3:merchant_staff_protect_identity_columns 觸發器確實存在'
);

select * from finish();
rollback;
