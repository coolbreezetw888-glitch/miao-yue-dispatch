-- 對應規格書 .project/specs/帳號登入安全性優化.md 第二節 2.4.1/2.4.2/2.4.3(問題 2:登入信箱
-- 變更機制)。涵蓋 request_staff/agent_login_email_change、clear_staff/agent_pending_login_email、
-- get_staff/agent_login_email_status,以及 2.2.1 邊界情況(merchant_staff 三個 pending 欄位
-- 不能被一般 UPDATE 直接改動,merchant_agents 本來就沒有給 authenticated 的 UPDATE 政策)。
begin;

select plan(33);

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

-- ===========================================================================
-- fixture:兩個商家(不同集團)——M1 是主要測試場景,M2 只是用來製造「不是這間店的管理員」的
-- 反例(adminB)。M1 底下各有一位「已開通登入/在職」的服務人員與客服,以及一位「尚未開通登入」
-- 的服務人員/「邀請中」的客服,用來測 request_* 的在職狀態檢查。
-- ===========================================================================
insert into auth.users (id, email) values
  ('e1710000-0000-4000-8000-000000000001', 'pgtap-admin-a@test.local'),
  ('e1710000-0000-4000-8000-000000000002', 'pgtap-admin-b@test.local'),
  ('e1710000-0000-4000-8000-000000000003', 'pgtap-staff-active@test.local'),
  ('e1710000-0000-4000-8000-000000000004', 'pgtap-agent-active@test.local');

insert into groups (id) values
  ('e1710000-0000-4000-8000-000000000010'),
  ('e1710000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('e1710000-0000-4000-8000-000000000020', 'e1710000-0000-4000-8000-000000000010', '登入信箱安全性測試商家 M1', 'on_site_dispatch'),
  ('e1710000-0000-4000-8000-000000000021', 'e1710000-0000-4000-8000-000000000011', '登入信箱安全性測試商家 M2', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id) values
  ('e1710000-0000-4000-8000-000000000020', 'e1710000-0000-4000-8000-000000000001'),
  ('e1710000-0000-4000-8000-000000000021', 'e1710000-0000-4000-8000-000000000002');

insert into merchant_staff (id, merchant_id, name, status, login_status, user_id) values
  ('e1710000-0000-4000-8000-000000000030', 'e1710000-0000-4000-8000-000000000020', '在職且已開通登入的服務人員', 'active', 'active', 'e1710000-0000-4000-8000-000000000003'),
  ('e1710000-0000-4000-8000-000000000031', 'e1710000-0000-4000-8000-000000000020', '尚未開通登入的服務人員', 'active', 'not_invited', null);

insert into merchant_agents (id, merchant_id, name, invited_email, status, user_id) values
  ('e1710000-0000-4000-8000-000000000040', 'e1710000-0000-4000-8000-000000000020', '在職客服', 'pgtap-agent-active@test.local', 'active', 'e1710000-0000-4000-8000-000000000004'),
  ('e1710000-0000-4000-8000-000000000041', 'e1710000-0000-4000-8000-000000000020', '邀請中的客服', 'pgtap-agent-invited@test.local', 'invited', null);

-- ===========================================================================
-- 2.4.1 request_staff_login_email_change
-- ===========================================================================
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001'); -- adminA(M1 管理員)

select lives_ok(
  $$select request_staff_login_email_change('e1710000-0000-4000-8000-000000000030', 'newstaff@test.local')$$,
  '①(核心必測):M1 管理員建議在職服務人員的新信箱,成功執行'
);

select is(
  (select pending_admin_login_email from merchant_staff where id = 'e1710000-0000-4000-8000-000000000030'),
  'newstaff@test.local',
  '①:pending_admin_login_email 正確寫入'
);

select is(
  (select pending_admin_login_email_requested_by from merchant_staff where id = 'e1710000-0000-4000-8000-000000000030'),
  'e1710000-0000-4000-8000-000000000001'::uuid,
  '①:pending_admin_login_email_requested_by 正確記錄是哪位管理員建議的'
);

select ok(
  (select pending_admin_login_email_requested_at is not null from merchant_staff where id = 'e1710000-0000-4000-8000-000000000030'),
  '①:pending_admin_login_email_requested_at 已寫入時間'
);

-- ②(核心必測):不是這間店的管理員(adminB 是 M2 的管理員)被擋下。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000002');
select throws_ok(
  $$select request_staff_login_email_change('e1710000-0000-4000-8000-000000000030', 'hijack@test.local')$$,
  '42501',
  NULL,
  '②(核心必測):不是這間店的管理員,建議新信箱被擋下'
);

-- ③:目標人員尚未開通登入,被擋下。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001');
select throws_ok(
  $$select request_staff_login_email_change('e1710000-0000-4000-8000-000000000031', 'newstaff2@test.local')$$,
  'P0001',
  '這位服務人員尚未開通登入,無法設定登入信箱建議',
  '③:目標服務人員尚未開通登入,被擋下'
);

-- ④:信箱格式不正確,被擋下。
select throws_ok(
  $$select request_staff_login_email_change('e1710000-0000-4000-8000-000000000030', 'not-an-email')$$,
  'P0001',
  '信箱格式不正確',
  '④:信箱格式不正確,被擋下'
);

-- ===========================================================================
-- 2.4.3 get_staff_login_email_status
-- ===========================================================================
-- ⑤:非管理員(adminB)查詢被擋下。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000002');
select throws_ok(
  $$select * from get_staff_login_email_status('e1710000-0000-4000-8000-000000000030')$$,
  '42501',
  NULL,
  '⑤:非管理員查詢登入信箱狀態被擋下'
);

-- ⑥(核心必測):管理員查詢——只有「管理員建議」這一種狀態存在,「原生待驗證」還沒有。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001');
select is(
  (select current_login_email from get_staff_login_email_status('e1710000-0000-4000-8000-000000000030')),
  'pgtap-staff-active@test.local',
  '⑥:current_login_email 即時查 auth.users,不是 invited_login_email 那份歷史快照'
);
select is(
  (select pending_admin_suggested_email from get_staff_login_email_status('e1710000-0000-4000-8000-000000000030')),
  'newstaff@test.local',
  '⑥:pending_admin_suggested_email 正確回傳①寫入的建議'
);
select ok(
  (select pending_confirmation_email from get_staff_login_email_status('e1710000-0000-4000-8000-000000000030')) is null,
  '⑥:pending_confirmation_email 目前是 null(本人還沒按套用,Supabase 還沒寄出驗證信)'
);
select ok(
  (select pending_confirmation_sent_at from get_staff_login_email_status('e1710000-0000-4000-8000-000000000030')) is null,
  '⑥:pending_confirmation_sent_at 目前是 null'
);

-- 尚未開通登入的服務人員:current_login_email 應該是 null(user_id is null)。
select ok(
  (select current_login_email from get_staff_login_email_status('e1710000-0000-4000-8000-000000000031')) is null,
  '⑥:尚未開通登入的服務人員,current_login_email 回傳 null'
);

-- ===========================================================================
-- 模擬「本人已經按套用」:Supabase 原生會把 new_email/email_change_sent_at 寫進 auth.users
-- (這裡直接用 postgres 身份模擬這個原生狀態,不透過我們自己的函式——這兩個欄位本來就不是
-- 我們的函式該維護的,規則 2.3.3)。
-- ===========================================================================
-- 注意:auth.users 實際存放待驗證新信箱的欄位是 email_change,不是 new_email
-- (new_email 只是 supabase-js User 物件回傳給前端 JSON 時用的欄位名稱,見
-- 20260921170200_login_email_security_email_change_column_fix.sql 的修正說明)。
select pg_temp.test_clear_auth();
update auth.users
set email_change = 'newstaff@test.local', email_change_sent_at = now()
where id = 'e1710000-0000-4000-8000-000000000003';

-- ⑦:不相干的人(adminB)清除建議被擋下。
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000002');
select throws_ok(
  $$select clear_staff_pending_login_email('e1710000-0000-4000-8000-000000000030')$$,
  '42501',
  NULL,
  '⑦:不相干的人清除服務人員的登入信箱建議被擋下'
);

-- ⑧(核心必測):服務人員本人(套用後)清除自己的建議,成功。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000003');
select lives_ok(
  $$select clear_staff_pending_login_email('e1710000-0000-4000-8000-000000000030')$$,
  '⑧(核心必測):服務人員本人清除自己的登入信箱建議,成功'
);
select pg_temp.test_clear_auth();
select ok(
  (select pending_admin_login_email from merchant_staff where id = 'e1710000-0000-4000-8000-000000000030') is null,
  '⑧:清除後 pending_admin_login_email 變成 null'
);

-- ⑨(核心必測):兩種待驗證狀態分開顯示——這時 pending_admin_suggested_email 應該是 null,
-- pending_confirmation_email 應該是模擬寫入的原生待驗證信箱(規則 2.3.3)。
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001');
select ok(
  (select pending_admin_suggested_email from get_staff_login_email_status('e1710000-0000-4000-8000-000000000030')) is null,
  '⑨:清除建議後 pending_admin_suggested_email 變成 null'
);
select is(
  (select pending_confirmation_email from get_staff_login_email_status('e1710000-0000-4000-8000-000000000030')),
  'newstaff@test.local',
  '⑨(核心必測):pending_confirmation_email 正確回傳 auth.users.new_email(原生待驗證狀態,不受①-⑧的建議欄位影響)'
);

-- ===========================================================================
-- 2.2.1 邊界情況(核心必測):merchant_staff 的三個 pending 欄位不能被一般 UPDATE 直接改動,
-- 只能透過 request_staff_login_email_change/clear_staff_pending_login_email——即使呼叫者是
-- 這間店真正的管理員、原本就有 merchant_staff_update 政策允許他 .update() 整列,也一樣被擋下。
--
-- 測試環境注意事項(不影響正式環境行為):①/⑧ 呼叫 request_staff_login_email_change/
-- clear_staff_pending_login_email 時,函式內部用 set_config(..., true) 打開的
-- transaction-local 旗標,理論上應該在該次呼叫所在的交易結束時自動失效——但 pgTAP 的
-- lives_ok/throws_ok 是用 SAVEPOINT 包住每一句斷言,RELEASE SAVEPOINT(呼叫成功時)不會讓
-- local 設定跟著重置,只有 ROLLBACK TO SAVEPOINT 才會,所以這個旗標在 pgTAP 這個「一個交易
-- 跑完整份測試腳本」的環境裡,會一路殘留到腳本結束。正式環境不會有這個問題(PostgREST 每次
-- RPC 呼叫都是各自獨立的交易,呼叫結束交易一定會 commit/rollback,local 設定必定重置)——
-- 這裡在測試腳本裡手動重置乾淨,才能真的測到「一般直接 UPDATE(沒有旗標)會被擋下」這個情境。
select set_config('staff_agent.bypass_pending_login_email_guard', 'off', true);
select throws_ok(
  $$update merchant_staff set pending_admin_login_email = 'hacker-direct-update@test.local' where id = 'e1710000-0000-4000-8000-000000000030'$$,
  '42501',
  NULL,
  '⑩(核心必測):管理員直接 UPDATE merchant_staff.pending_admin_login_email 被觸發器擋下'
);

-- 確認觸發器沒有誤傷既有的正常編輯(例如改名字),不是整張表都不能 UPDATE 了。
select lives_ok(
  $$update merchant_staff set name = '在職且已開通登入的服務人員(改名)' where id = 'e1710000-0000-4000-8000-000000000030'$$,
  '⑩:觸發器只擋 pending_admin_login_email* 三個欄位,一般欄位(如姓名)依然能正常編輯'
);

select pg_temp.test_clear_auth();

-- ===========================================================================
-- 2.4.1/2.4.2/2.4.3 客服版本,設計理由完全比照服務人員版本。
-- ===========================================================================
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001');

select lives_ok(
  $$select request_agent_login_email_change('e1710000-0000-4000-8000-000000000040', 'newagent@test.local')$$,
  '⑪:M1 管理員建議在職客服的新信箱,成功執行'
);
select is(
  (select pending_admin_login_email from merchant_agents where id = 'e1710000-0000-4000-8000-000000000040'),
  'newagent@test.local',
  '⑪:客服版本 pending_admin_login_email 正確寫入'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000002');
select throws_ok(
  $$select request_agent_login_email_change('e1710000-0000-4000-8000-000000000040', 'hijack@test.local')$$,
  '42501',
  NULL,
  '⑫:不是這間店的管理員,建議客服新信箱被擋下'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001');
select throws_ok(
  $$select request_agent_login_email_change('e1710000-0000-4000-8000-000000000041', 'newagent2@test.local')$$,
  'P0001',
  '這位客服尚未開通登入,無法設定登入信箱建議',
  '⑬:邀請中(尚未開通登入)的客服,被擋下'
);

select throws_ok(
  $$select request_agent_login_email_change('e1710000-0000-4000-8000-000000000040', 'not-an-email')$$,
  'P0001',
  '信箱格式不正確',
  '⑭:客服版本信箱格式不正確,被擋下'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000002');
select throws_ok(
  $$select * from get_agent_login_email_status('e1710000-0000-4000-8000-000000000040')$$,
  '42501',
  NULL,
  '⑮:非管理員查詢客服登入信箱狀態被擋下'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001');
select is(
  (select current_login_email from get_agent_login_email_status('e1710000-0000-4000-8000-000000000040')),
  'pgtap-agent-active@test.local',
  '⑯:客服版本 current_login_email 即時查 auth.users'
);
select is(
  (select pending_admin_suggested_email from get_agent_login_email_status('e1710000-0000-4000-8000-000000000040')),
  'newagent@test.local',
  '⑯:客服版本 pending_admin_suggested_email 正確回傳'
);

-- ⑰:不相干的人清除客服的建議被擋下。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000003');
select throws_ok(
  $$select clear_agent_pending_login_email('e1710000-0000-4000-8000-000000000040')$$,
  '42501',
  NULL,
  '⑰:不相干的人清除客服的登入信箱建議被擋下'
);

-- ⑱(核心必測):客服本人清除自己的建議,成功。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000004');
select lives_ok(
  $$select clear_agent_pending_login_email('e1710000-0000-4000-8000-000000000040')$$,
  '⑱(核心必測):客服本人清除自己的登入信箱建議,成功'
);
select pg_temp.test_clear_auth();
select ok(
  (select pending_admin_login_email from merchant_agents where id = 'e1710000-0000-4000-8000-000000000040') is null,
  '⑱:清除後客服版本 pending_admin_login_email 變成 null'
);

-- ===========================================================================
-- merchant_agents 本來就沒有給 authenticated 的 UPDATE RLS 政策(唯一政策是
-- merchant_agents_select),所以就算是這間店真正的管理員,直接 UPDATE 也完全不會生效
-- (RLS 過濾掉所有列,不是拋例外,而是靜靜地 0 rows affected)——不需要額外的觸發器保護。
-- ===========================================================================
select pg_temp.test_set_auth('e1710000-0000-4000-8000-000000000001');
select lives_ok(
  $$update merchant_agents set pending_admin_login_email = 'hacker-direct-update@test.local' where id = 'e1710000-0000-4000-8000-000000000040'$$,
  '⑲:管理員直接 UPDATE merchant_agents 不會拋例外(RLS 沒有 UPDATE 政策,靜靜地 0 rows affected)'
);
select pg_temp.test_clear_auth();
select ok(
  (select pending_admin_login_email from merchant_agents where id = 'e1710000-0000-4000-8000-000000000040') is null,
  '⑲(核心必測):直接 UPDATE 完全沒有生效,pending_admin_login_email 依然是 null'
);

select * from finish();

rollback;
