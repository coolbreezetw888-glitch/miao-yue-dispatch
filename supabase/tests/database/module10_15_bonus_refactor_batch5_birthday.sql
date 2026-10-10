-- 紅利系統重構 批次 5:生日獎勵排程(規格書 .project/specs/紅利系統重構.md §八 批次 5、§1.7、§2.9、§3.6、
-- §3.7、§3.8、§3.12)。對應 migration:20261001060000_bonus_refactor_batch5_birthday.sql
--
-- 這一檔鎖住的行為:
--   A. 權限與結構:run/claim/mark 只給 postgres/service_role;get_birthday_bonus_grants 給 authenticated;
--      SECURITY DEFINER 都有 search_path;舊 grant_pending_birthday_bonuses 已不存在;兩個 cron 排程存在、
--      時間正確、排程 B 的密鑰只從 Vault 讀(指令裡沒有任何密鑰值)
--   B. 錨定日:2/29 平年 → 2/28、閏年 → 2/29
--   C. 發放(核心必測):當天、窗口邊界(−6 天在內、−7 天在外、明天不發)、沒生日不發、已下架不發、
--      黑名單照發、未綁 LINE 照發;分類帳 / 餘額 / 發送紀錄 / last_birthday_bonus_year 同步;
--      同一天重跑不重發、隔天跑不重發;跨商家各算各的
--   D. 2/29 生日:平年 2/28 發、閏年 2/28 不發 2/29 才發;跨年補發(12/31 生日 1/3 才跑到)
--   E. 資格:功能總開關關閉、生日開關關閉、0 點 ⇒ 不發不留紀錄;生日開關打開後窗口內補發;
--      reward_condition_mode 不符跳過且不留紀錄、之後符合窗口內補發;錨定日那天功能關著 ⇒ 永不補發
--   F. 台北時區:p_run_date 為 null 時用台北日期(session 時區故意設成跟台北不同日的時區)
--   G. LINE 認領 / 回寫:未綁 ⇒ skipped_not_bound、商家未連線 ⇒ skipped_not_connected、只回傳要發的列、
--      認領後不會被重複撈、回寫 sent / failed、不覆蓋既有結果、狀態值與發送紀錄歸屬驗證、
--      中斷超過 30 分鐘 ⇒ failed、超過 7 天未發 ⇒ failed;LINE 失敗不影響點數
--   H. 紀錄清單:最近 50 筆、新到舊、跨商家隔離、members / member_points 任一放行、其他 42501
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(103);

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

create function pg_temp.bal(p_member uuid)
returns int language sql as $$ select points_balance from public.members where id = p_member; $$;

create function pg_temp.gcount(p_member uuid)
returns int language sql as $$ select count(*)::int from public.member_birthday_bonus_grants where member_id = p_member; $$;

create function pg_temp.gstatus(p_member uuid, p_year int)
returns text language sql as $$
  select line_status from public.member_birthday_bonus_grants where member_id = p_member and bonus_year = p_year;
$$;

create function pg_temp.gid(p_member uuid, p_year int)
returns uuid language sql as $$
  select id from public.member_birthday_bonus_grants where member_id = p_member and bonus_year = p_year;
$$;

-- =========================================================================
-- Fixture
--   A 店:啟用、30 點、資格 none、LINE 已連線(主要情境)
--   B 店:啟用、50 點、LINE 未設定(跨商家 + 未連線)
--   C 店:功能總開關關閉;D 店:生日開關關閉;E 店:生日 0 點
--   F 店:資格 line_bound;G 店:手工造「錨定日那天功能關著」的歷史
--   K 店:灌 55 筆紀錄測清單上限
-- =========================================================================
insert into auth.users (id, email) values
  ('db150000-0000-4000-8000-000000000001', 'pgtap-m1015-admin-a@test.local'),
  ('db150000-0000-4000-8000-000000000002', 'pgtap-m1015-admin-b@test.local'),
  ('db150000-0000-4000-8000-000000000003', 'pgtap-m1015-agent-points@test.local'),
  ('db150000-0000-4000-8000-000000000004', 'pgtap-m1015-agent-members@test.local'),
  ('db150000-0000-4000-8000-000000000005', 'pgtap-m1015-agent-orders@test.local'),
  ('db150000-0000-4000-8000-000000000006', 'pgtap-m1015-admin-k@test.local');

insert into groups (id) values
  ('db150000-0000-4000-8000-000000000010'),
  ('db150000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('db150000-0000-4000-8000-0000000000a1', 'db150000-0000-4000-8000-000000000010', '生日測試A店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000a2', 'db150000-0000-4000-8000-000000000011', '生日測試B店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000a3', 'db150000-0000-4000-8000-000000000010', '生日測試C店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000a4', 'db150000-0000-4000-8000-000000000010', '生日測試D店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000a5', 'db150000-0000-4000-8000-000000000010', '生日測試E店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000a6', 'db150000-0000-4000-8000-000000000010', '生日測試F店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000a7', 'db150000-0000-4000-8000-000000000010', '生日測試G店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000a8', 'db150000-0000-4000-8000-000000000010', '生日測試H店', 'in_store_beauty'),
  ('db150000-0000-4000-8000-0000000000ab', 'db150000-0000-4000-8000-000000000011', '生日測試K店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('db150000-0000-4000-8000-0000000000a1', 'db150000-0000-4000-8000-000000000001'),
  ('db150000-0000-4000-8000-0000000000a2', 'db150000-0000-4000-8000-000000000002'),
  ('db150000-0000-4000-8000-0000000000ab', 'db150000-0000-4000-8000-000000000006');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('db150000-0000-4000-8000-000000000051', 'db150000-0000-4000-8000-0000000000a1',
   'db150000-0000-4000-8000-000000000003', '客服P', '0900015001', 'pgtap-m1015-agent-points@test.local', 'active'),
  ('db150000-0000-4000-8000-000000000052', 'db150000-0000-4000-8000-0000000000a1',
   'db150000-0000-4000-8000-000000000004', '客服M', '0900015002', 'pgtap-m1015-agent-members@test.local', 'active'),
  ('db150000-0000-4000-8000-000000000053', 'db150000-0000-4000-8000-0000000000a1',
   'db150000-0000-4000-8000-000000000005', '客服O', '0900015003', 'pgtap-m1015-agent-orders@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('db150000-0000-4000-8000-000000000051', 'member_points', true),
  ('db150000-0000-4000-8000-000000000052', 'members', true),
  ('db150000-0000-4000-8000-000000000053', 'orders', true);

insert into merchant_member_settings (merchant_id, birthday_bonus_enabled, birthday_bonus_points, birthday_line_message, points_feature_enabled, reward_condition_mode) values
  ('db150000-0000-4000-8000-0000000000a1', true, 30, '{{member_name}} 生日快樂！{{merchant_name}} 送您 {{points}} 點', true, 'none'),
  ('db150000-0000-4000-8000-0000000000a2', true, 50, '生日快樂', true, 'none'),
  ('db150000-0000-4000-8000-0000000000a3', true, 30, '生日快樂', false, 'none'),
  ('db150000-0000-4000-8000-0000000000a4', false, 30, '生日快樂', true, 'none'),
  ('db150000-0000-4000-8000-0000000000a5', true, 0, '生日快樂', true, 'none'),
  ('db150000-0000-4000-8000-0000000000a6', true, 30, '生日快樂', true, 'line_bound'),
  ('db150000-0000-4000-8000-0000000000a7', true, 30, '生日快樂', true, 'none'),
  ('db150000-0000-4000-8000-0000000000a8', true, 30, '生日快樂', true, 'none'),
  ('db150000-0000-4000-8000-0000000000ab', true, 30, '生日快樂', true, 'none');

insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected) values
  ('db150000-0000-4000-8000-0000000000a1', 'ch-a', 'secret-a', 'token-a', true),
  -- F 店有設定列但未連線(is_connected = false)
  ('db150000-0000-4000-8000-0000000000a6', 'ch-f', 'secret-f', 'token-f', false);

-- 會員。生日年份不影響(只比月 / 日);2/29 生日用 2000 年。
insert into members (id, merchant_id, name, phone, referral_code, birthday, status, is_blacklisted, line_bound, line_user_id, points_balance) values
  -- A 店:3/10 情境
  ('db150000-0000-4000-8000-000000000101', 'db150000-0000-4000-8000-0000000000a1', '當天生日', '0915000101', 'M1015A01', '1990-03-10', 'active', false, false, null, 5),
  ('db150000-0000-4000-8000-000000000102', 'db150000-0000-4000-8000-0000000000a1', '六天前生日', '0915000102', 'M1015A02', '1990-03-04', 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000103', 'db150000-0000-4000-8000-0000000000a1', '七天前生日', '0915000103', 'M1015A03', '1990-03-03', 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000104', 'db150000-0000-4000-8000-0000000000a1', '明天生日', '0915000104', 'M1015A04', '1990-03-11', 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000105', 'db150000-0000-4000-8000-0000000000a1', '沒填生日', '0915000105', 'M1015A05', null, 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000106', 'db150000-0000-4000-8000-0000000000a1', '已下架', '0915000106', 'M1015A06', '1990-03-10', 'removed', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000107', 'db150000-0000-4000-8000-0000000000a1', '黑名單', '0915000107', 'M1015A07', '1990-03-10', 'active', true, false, null, 0),
  ('db150000-0000-4000-8000-000000000109', 'db150000-0000-4000-8000-0000000000a1', '已綁LINE', '0915000109', 'M1015A09', '1990-03-10', 'active', false, true, 'U-line-109', 0),
  -- A 店:2/29、跨年
  ('db150000-0000-4000-8000-000000000111', 'db150000-0000-4000-8000-0000000000a1', '二二九', '0915000111', 'M1015A11', '2000-02-29', 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000112', 'db150000-0000-4000-8000-0000000000a1', '跨年', '0915000112', 'M1015A12', '1990-12-31', 'active', false, false, null, 0),
  -- A 店:7 月 LINE 認領情境(都已綁 LINE)
  ('db150000-0000-4000-8000-000000000121', 'db150000-0000-4000-8000-0000000000a1', '過期未發', '0915000121', 'M1015A21', '1990-07-10', 'active', false, true, 'U-line-121', 0),
  ('db150000-0000-4000-8000-000000000122', 'db150000-0000-4000-8000-0000000000a1', '中斷', '0915000122', 'M1015A22', '1990-07-11', 'active', false, true, 'U-line-122', 0),
  ('db150000-0000-4000-8000-000000000123', 'db150000-0000-4000-8000-0000000000a1', '發送失敗', '0915000123', 'M1015A23', '1990-07-12', 'active', false, true, 'U-line-123', 0),
  -- B 店:3/10(跨商家;已綁 LINE 但商家沒設定 LINE)
  ('db150000-0000-4000-8000-000000000201', 'db150000-0000-4000-8000-0000000000a2', 'B店當天生日', '0915000201', 'M1015B01', '1990-03-10', 'active', false, true, 'U-line-201', 0),
  -- C/D/E 店:4/10
  ('db150000-0000-4000-8000-000000000301', 'db150000-0000-4000-8000-0000000000a3', 'C店', '0915000301', 'M1015C01', '1990-04-10', 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000401', 'db150000-0000-4000-8000-0000000000a4', 'D店', '0915000401', 'M1015D01', '1990-04-10', 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000501', 'db150000-0000-4000-8000-0000000000a5', 'E店', '0915000501', 'M1015E01', '1990-04-10', 'active', false, false, null, 0),
  -- F 店:5/10(資格 line_bound)
  ('db150000-0000-4000-8000-000000000601', 'db150000-0000-4000-8000-0000000000a6', 'F店已綁', '0915000601', 'M1015F01', '1990-05-10', 'active', false, true, 'U-line-601', 0),
  ('db150000-0000-4000-8000-000000000602', 'db150000-0000-4000-8000-0000000000a6', 'F店未綁', '0915000602', 'M1015F02', '1990-05-10', 'active', false, false, null, 0),
  -- G 店:6/10 錨定日那天功能關著;6/25 對照組
  ('db150000-0000-4000-8000-000000000701', 'db150000-0000-4000-8000-0000000000a7', 'G店關閉日生日', '0915000701', 'M1015G01', '1990-06-10', 'active', false, false, null, 0),
  ('db150000-0000-4000-8000-000000000702', 'db150000-0000-4000-8000-0000000000a7', 'G店對照', '0915000702', 'M1015G02', '1990-06-25', 'active', false, false, null, 0);

-- =========================================================================
-- A. 權限與結構
-- =========================================================================
select ok(
  not has_function_privilege('authenticated', 'public.run_birthday_bonus_grants(date)', 'execute')
  and not has_function_privilege('anon', 'public.run_birthday_bonus_grants(date)', 'execute')
  and not has_function_privilege('public', 'public.run_birthday_bonus_grants(date)', 'execute'),
  'A1 §3.6:run_birthday_bonus_grants 不對 authenticated / anon / public 開放'
);
select ok(
  has_function_privilege('service_role', 'public.run_birthday_bonus_grants(date)', 'execute'),
  'A2 §3.6(正向對照):service_role 可以執行 run_birthday_bonus_grants'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_birthday_line_pending(integer)', 'execute')
  and not has_function_privilege('anon', 'public.claim_birthday_line_pending(integer)', 'execute')
  and not has_function_privilege('public', 'public.claim_birthday_line_pending(integer)', 'execute')
  and has_function_privilege('service_role', 'public.claim_birthday_line_pending(integer)', 'execute'),
  'A3 §3.7:claim_birthday_line_pending(回傳含 LINE token)只給 service_role'
);
select ok(
  not has_function_privilege('authenticated', 'public.mark_birthday_line_result(uuid, text, text, uuid)', 'execute')
  and not has_function_privilege('anon', 'public.mark_birthday_line_result(uuid, text, text, uuid)', 'execute')
  and not has_function_privilege('public', 'public.mark_birthday_line_result(uuid, text, text, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.mark_birthday_line_result(uuid, text, text, uuid)', 'execute'),
  'A4 §3.7:mark_birthday_line_result 只給 service_role'
);
select ok(
  has_function_privilege('authenticated', 'public.get_birthday_bonus_grants(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_birthday_bonus_grants(uuid)', 'execute')
  and not has_function_privilege('public', 'public.get_birthday_bonus_grants(uuid)', 'execute'),
  'A5 §3.8:get_birthday_bonus_grants 給 authenticated(函式內再檢查鑰匙),anon / public 不行'
);
select ok(
  not has_function_privilege('authenticated', 'private.birthday_anchor_date(date, integer)', 'execute')
  and not has_function_privilege('public', 'private.birthday_anchor_date(date, integer)', 'execute'),
  'A6:private.birthday_anchor_date 不對外開放'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('run_birthday_bonus_grants', 'claim_birthday_line_pending', 'mark_birthday_line_result', 'get_birthday_bonus_grants')
     and p.prosecdef
     and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')),
  4,
  'A7:四支 SECURITY DEFINER 函式都有固定 search_path'
);
select ok(
  to_regprocedure('public.grant_pending_birthday_bonuses(uuid)') is null
  and to_regprocedure('public.run_birthday_bonus_grants(date)') is not null,
  'A8 §3.12:舊的 grant_pending_birthday_bonuses 已廢止(正向對照:新函式查得到)'
);
select is(
  (select array_agg(jobname || ' ' || schedule order by jobname) from cron.job
   where jobname in ('birthday-bonus-grant-daily', 'birthday-line-dispatch-daily')),
  array['birthday-bonus-grant-daily 5 16 * * *', 'birthday-line-dispatch-daily 10 1 * * *'],
  'A9 §1.7 / 第 11 題:兩個排程存在,UTC 16:05(台北 00:05)發點、UTC 01:10(台北 09:10)發 LINE'
);
select ok(
  (select command like '%run_birthday_bonus_grants()%' from cron.job where jobname = 'birthday-bonus-grant-daily')
  and (select command like '%/functions/v1/birthday-line-dispatch%'
              and command like '%vault.decrypted_secrets where name = ''birthday_line_cron_secret''%'
       from cron.job where jobname = 'birthday-line-dispatch-daily'),
  'A10 §1.7:排程 A 呼叫 run_birthday_bonus_grants;排程 B 打 birthday-line-dispatch,密鑰執行當下才從 Vault 讀(指令裡沒有密鑰值)'
);

select is(
  (select array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('claim_birthday_line_pending', 'mark_birthday_line_result')),
  array['claim_birthday_line_pending(p_limit integer)',
        'mark_birthday_line_result(p_grant_id uuid, p_status text, p_error text, p_log_id uuid)'],
  'A11(Edge Function 契約,比照 security_audit_06):birthday-line-dispatch 用具名參數呼叫的兩支 RPC 各只有一個版本、參數名一致'
);

-- =========================================================================
-- B. 錨定日
-- =========================================================================
select is(private.birthday_anchor_date('2000-02-29', 2027), '2027-02-28'::date, 'B1 §2.9 第 5 點:2/29 生日在平年錨定到 2/28');
select is(private.birthday_anchor_date('2000-02-29', 2028), '2028-02-29'::date, 'B2 §2.9 第 5 點:2/29 生日在閏年錨定到 2/29');
select is(private.birthday_anchor_date('1990-12-31', 2027), '2027-12-31'::date, 'B3:一般日期照月 / 日');

-- =========================================================================
-- C. 發放(核心必測)— 跑 2027-03-10(台北)
-- =========================================================================
select is(run_birthday_bonus_grants('2027-03-10'), 5,
  'C1 §2.9:2027-03-10 發給 A 店當天 / 六天前 / 黑名單 / 已綁 LINE 四位 + B 店一位,共 5 人');

select is(pg_temp.bal('db150000-0000-4000-8000-000000000101'), 35, 'C2:當天生日會員 5 + 30 = 35 點');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000102'), 30, 'C3 §2.9 第 2 點:錨定日 = 今天 − 6 天(窗口最早一天)照發');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000103'), 0, 'C4 §2.9 第 2 點:錨定日 = 今天 − 7 天(窗口外)不發');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000104'), 0, 'C5:明天生日今天不發');
select is(pg_temp.gcount('db150000-0000-4000-8000-000000000105'), 0, 'C6:沒填生日不發、不留紀錄');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000106') + pg_temp.gcount('db150000-0000-4000-8000-000000000106'), 0,
  'C7 §2.9 第 2 點:已下架(status = removed)會員不發、不留紀錄');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000107'), 30, 'C8 第 16 題:黑名單會員照樣發');
select is(pg_temp.gstatus('db150000-0000-4000-8000-000000000101', 2027), 'pending',
  'C9 §2.9 第 4 點:未綁 LINE 仍給點,發送紀錄先記 pending(由排程 B 判定略過)');

select is(
  (select row(t.transaction_type, t.points_delta, t.balance_after, t.merchant_id)::text
   from member_birthday_bonus_grants g join member_point_transactions t on t.id = g.point_transaction_id
   where g.member_id = 'db150000-0000-4000-8000-000000000101'),
  row('birthday_bonus', 30, 35, 'db150000-0000-4000-8000-0000000000a1'::uuid)::text,
  'C10 §2.9 第 3 點:發送紀錄對應的分類帳是 birthday_bonus +30、balance_after = 35'
);
select is(
  (select row(bonus_year, anchor_date, points, member_name_snapshot, merchant_id)::text
   from member_birthday_bonus_grants where member_id = 'db150000-0000-4000-8000-000000000102'),
  row(2027, '2027-03-04'::date, 30, '六天前生日', 'db150000-0000-4000-8000-0000000000a1'::uuid)::text,
  'C11 §1.3:發送紀錄的年份、錨定日、點數、姓名快照、商家正確'
);
select is(
  (select last_birthday_bonus_year from members where id = 'db150000-0000-4000-8000-000000000101'),
  2027,
  'C12 §1.3:同步相容寫入 members.last_birthday_bonus_year'
);
select is(pg_temp.bal('db150000-0000-4000-8000-000000000201'), 50, 'C13 跨商家:B 店會員照 B 店設定拿 50 點');
select is(
  (select merchant_id from member_birthday_bonus_grants where member_id = 'db150000-0000-4000-8000-000000000201'),
  'db150000-0000-4000-8000-0000000000a2'::uuid,
  'C14 跨商家:B 店會員的發送紀錄掛在 B 店'
);

-- 同一天重跑(排程重疊 / 人工重跑)
select is(run_birthday_bonus_grants('2027-03-10'), 0, 'C15 §2.9 第 6 點(核心):同一天重跑不重發,回傳 0');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000101'), 35, 'C16(核心):重跑後餘額不變');
select is(
  (select count(*)::int from member_point_transactions
   where member_id = 'db150000-0000-4000-8000-000000000101' and transaction_type = 'birthday_bonus'),
  1,
  'C17(核心):重跑後分類帳仍只有 1 筆 birthday_bonus'
);
-- 隔天:窗口內但今年已發過的不重發;明天生日那位這天才發
select is(run_birthday_bonus_grants('2027-03-11'), 1, 'C18:隔天只發給 3/11 生日那一位(其他人今年已發過)');
select is(pg_temp.gcount('db150000-0000-4000-8000-000000000101'), 1, 'C19(核心):每位會員每年只有一筆發送紀錄');

-- =========================================================================
-- D. 2/29 與跨年
-- =========================================================================
select is(run_birthday_bonus_grants('2027-02-28'), 1, 'D1 §2.9 第 5 點:2/29 生日在平年 2/28 發');
select is(
  (select anchor_date from member_birthday_bonus_grants where member_id = 'db150000-0000-4000-8000-000000000111' and bonus_year = 2027),
  '2027-02-28'::date,
  'D2:平年紀錄的錨定日是 2/28'
);
select is(run_birthday_bonus_grants('2028-02-28'), 0, 'D3:閏年 2/28 還不發(錨定日是 2/29,還沒到)');
select is(run_birthday_bonus_grants('2028-02-29'), 1, 'D4:閏年 2/29 當天發');
select is(run_birthday_bonus_grants('2028-03-01'), 0, 'D5:閏年 3/1 不再重發');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000111'), 60, 'D6:2/29 會員兩年各拿一次,共 60 點');

select is(run_birthday_bonus_grants('2028-01-03'), 1, 'D7 跨年補發:12/31 生日、隔年 1/3 才跑到,仍在 7 天窗口內照發');
select is(
  (select row(bonus_year, anchor_date)::text from member_birthday_bonus_grants
   where member_id = 'db150000-0000-4000-8000-000000000112'),
  row(2027, '2027-12-31'::date)::text,
  'D8 跨年補發:記在生日所在的 2027 年'
);
select is(run_birthday_bonus_grants('2028-12-31'), 1, 'D9:同一位會員 2028 年生日照常再發一次(不同年份)');

-- =========================================================================
-- E. 資格 — 4/10、5/10、6/10
-- =========================================================================
select is(run_birthday_bonus_grants('2027-04-10'), 0, 'E1:功能總開關關閉 / 生日開關關閉 / 0 點的商家都不發');
select is(
  (select count(*)::int from member_birthday_bonus_grants
   where merchant_id in ('db150000-0000-4000-8000-0000000000a3', 'db150000-0000-4000-8000-0000000000a4', 'db150000-0000-4000-8000-0000000000a5'))
  + pg_temp.bal('db150000-0000-4000-8000-000000000301') + pg_temp.bal('db150000-0000-4000-8000-000000000401')
  + pg_temp.bal('db150000-0000-4000-8000-000000000501'),
  0,
  'E2 §1.3:三種不發的情況都不加點、也不留發送紀錄'
);
update merchant_member_settings set birthday_bonus_enabled = true where merchant_id = 'db150000-0000-4000-8000-0000000000a4';
select is(run_birthday_bonus_grants('2027-04-12'), 1, 'E3 §2.9:D 店兩天後才打開生日開關,窗口內補發');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000301'), 0, 'E4:C 店(功能總開關仍關閉)仍不發');
-- 把 C 店的開關歷史清掉(⇒ 錨定日那天「沒有歷史涵蓋」會被視為開著),證明擋下 C 店的是「現在」的總開關,
-- 不只是歷史判斷(兩道檢查各自都要有效)。
delete from merchant_points_feature_history where merchant_id = 'db150000-0000-4000-8000-0000000000a3';
select is(run_birthday_bonus_grants('2027-04-13') + pg_temp.gcount('db150000-0000-4000-8000-000000000301'), 0,
  'E4b §2.9 第 2 點:商家「目前」功能總開關關閉 ⇒ 不發(即使錨定日那天沒有關閉歷史)');

select is(run_birthday_bonus_grants('2027-05-10'), 1, 'E5 §2.7:資格 line_bound 的 F 店只發給已綁 LINE 的會員');
select is(pg_temp.gcount('db150000-0000-4000-8000-000000000602'), 0, 'E6:資格不符跳過且不留紀錄');
update members set line_bound = true, line_user_id = 'U-line-602' where id = 'db150000-0000-4000-8000-000000000602';
select is(run_birthday_bonus_grants('2027-05-13'), 1, 'E7:資格後來符合,窗口內補發');

-- G 店:2027-06-01 ~ 2027-06-20 功能關著(台北)
delete from merchant_points_feature_history where merchant_id = 'db150000-0000-4000-8000-0000000000a7';
insert into merchant_points_feature_history (merchant_id, enabled, effective_from, effective_to, is_backfill_seed) values
  ('db150000-0000-4000-8000-0000000000a7', true, '2025-01-01 00:00:00+08', '2027-06-01 00:00:00+08', true),
  ('db150000-0000-4000-8000-0000000000a7', false, '2027-06-01 00:00:00+08', '2027-06-20 00:00:00+08', false),
  ('db150000-0000-4000-8000-0000000000a7', true, '2027-06-20 00:00:00+08', null, false);
select is(run_birthday_bonus_grants('2027-06-10') + run_birthday_bonus_grants('2027-06-16'), 0,
  'E8(核心,沿用「關閉期間不補發」裁決):錨定日那天功能關著,當天與之後窗口內都不發');
select is(pg_temp.gcount('db150000-0000-4000-8000-000000000701'), 0, 'E9:關閉期間不補發也不寫任何假紀錄');
select is(run_birthday_bonus_grants('2027-06-25'), 1, 'E10(對照組):同店功能重新打開後生日的會員正常發');

-- =========================================================================
-- G. LINE 認領 / 回寫(排程 B 的資料庫端)
-- 目前 pending 的紀錄(3 月那批 + 其他情境)。A 店已連線、F 店未連線、B / D / G / H 店沒有 LINE 設定。
-- =========================================================================
create temporary table claimed1 as select claim_birthday_line_pending(100) as j;

select is(
  (select array_agg(j ->> 'grant_id' order by j ->> 'grant_id') from claimed1),
  array[pg_temp.gid('db150000-0000-4000-8000-000000000109', 2027)::text],
  'G1 §3.7 第 2 步:只回傳「已綁 LINE 且商家已連線」的那一筆(A 店已綁 LINE 會員)'
);
select is(
  (select j - 'grant_id' - 'merchant_id' - 'member_id' from claimed1),
  jsonb_build_object(
    'line_user_id', 'U-line-109', 'channel_access_token', 'token-a',
    'message_template', '{{member_name}} 生日快樂！{{merchant_name}} 送您 {{points}} 點',
    'member_name', '已綁LINE', 'points', 30, 'merchant_name', '生日測試A店'),
  'G2:回傳內容含 LINE 對象、商家 token、文案範本與三個變數的值'
);
select is(pg_temp.gstatus('db150000-0000-4000-8000-000000000101', 2027), 'skipped_not_bound', 'G3:未綁 LINE ⇒ skipped_not_bound');
select is(pg_temp.gstatus('db150000-0000-4000-8000-000000000107', 2027), 'skipped_not_bound', 'G4:黑名單未綁 LINE 也一樣標 skipped_not_bound(第 16 題不排除黑名單)');
select is(pg_temp.gstatus('db150000-0000-4000-8000-000000000201', 2027), 'skipped_not_connected', 'G5:會員已綁、商家沒設定 LINE ⇒ skipped_not_connected');
select is(pg_temp.gstatus('db150000-0000-4000-8000-000000000601', 2027), 'skipped_not_connected', 'G6:商家有設定但 is_connected = false ⇒ skipped_not_connected');
select ok(
  (select line_status = 'pending' and line_attempted_at is not null
   from member_birthday_bonus_grants where id = pg_temp.gid('db150000-0000-4000-8000-000000000109', 2027)),
  'G7:被認領的那筆仍是 pending,但已寫入 line_attempted_at(認領標記)'
);
select is((select count(*)::int from claim_birthday_line_pending(100)), 0, 'G8:已認領 / 已略過的不會被下一次呼叫重複撈到(避免重複發送)');
select is(
  (select count(*)::int from member_birthday_bonus_grants where line_status = 'pending' and line_attempted_at is null
     and merchant_id::text like 'db150000-%'),
  0,
  'G9:這一輪之後本檔沒有任何未處理的 pending'
);

-- 回寫結果
insert into line_notification_log (id, merchant_id, event_type, target_type, target_id, target_line_user_id, status, rendered_message) values
  ('db150000-0000-4000-8000-000000000901', 'db150000-0000-4000-8000-0000000000a1', 'birthday_bonus', 'member',
   'db150000-0000-4000-8000-000000000109', 'U-line-109', 'sent', '已綁LINE 生日快樂！生日測試A店 送您 30 點'),
  ('db150000-0000-4000-8000-000000000902', 'db150000-0000-4000-8000-0000000000a2', 'birthday_bonus', 'member',
   'db150000-0000-4000-8000-000000000201', null, 'skipped', null);

select throws_ok(
  format($$select mark_birthday_line_result(%L, 'skipped')$$, pg_temp.gid('db150000-0000-4000-8000-000000000109', 2027)),
  '22023', '生日 LINE 發送結果只能是 sent 或 failed',
  'G10:回寫狀態只接受 sent / failed'
);
select throws_ok(
  format($$select mark_birthday_line_result(%L, 'sent', null, 'db150000-0000-4000-8000-000000000902')$$,
         pg_temp.gid('db150000-0000-4000-8000-000000000109', 2027)),
  '22023', '發送紀錄不屬於這筆生日贈點',
  'G11:不能掛上別家商家的 LINE 發送紀錄'
);
select is(
  mark_birthday_line_result(pg_temp.gid('db150000-0000-4000-8000-000000000109', 2027), 'sent', null, 'db150000-0000-4000-8000-000000000901'),
  true,
  'G12:回寫 sent 成功'
);
select is(
  (select row(line_status, line_error, line_notification_log_id)::text from member_birthday_bonus_grants
   where id = pg_temp.gid('db150000-0000-4000-8000-000000000109', 2027)),
  row('sent', null::text, 'db150000-0000-4000-8000-000000000901'::uuid)::text,
  'G13:狀態 sent、沒有錯誤、掛上發送紀錄'
);
select is(
  mark_birthday_line_result(pg_temp.gid('db150000-0000-4000-8000-000000000109', 2027), 'failed', '晚到的失敗'),
  false,
  'G14:已經有結果的不再覆蓋(重複回寫回 false)'
);
select is(pg_temp.gstatus('db150000-0000-4000-8000-000000000109', 2027), 'sent', 'G15:重複回寫後仍是 sent');
select is(
  mark_birthday_line_result(pg_temp.gid('db150000-0000-4000-8000-000000000201', 2027), 'sent'),
  false,
  'G16:已略過(skipped_not_connected)的不能被改成 sent'
);

-- 7 月:過期未發、中斷、發送失敗
select is(run_birthday_bonus_grants('2027-07-12'), 3, 'G17(前提):7 月三位已綁 LINE 的 A 店會員發點');
update member_birthday_bonus_grants set granted_at = now() - interval '8 days'
where id = pg_temp.gid('db150000-0000-4000-8000-000000000121', 2027);

create temporary table claimed2 as select claim_birthday_line_pending(100) as j;
select is(
  (select array_agg(j ->> 'grant_id' order by j ->> 'grant_id') from claimed2),
  (select array_agg(x::text order by x::text) from unnest(array[
     pg_temp.gid('db150000-0000-4000-8000-000000000122', 2027),
     pg_temp.gid('db150000-0000-4000-8000-000000000123', 2027)]) x),
  'G18:超過 7 天未發的那筆不再回傳,其餘兩筆被認領'
);
select is(
  (select row(line_status, line_error like '超過 7 天%')::text from member_birthday_bonus_grants
   where id = pg_temp.gid('db150000-0000-4000-8000-000000000121', 2027)),
  row('failed', true)::text,
  'G19:發點後超過 7 天才要發 ⇒ 標 failed 並寫明原因(不發過期祝福)'
);
select is(pg_temp.bal('db150000-0000-4000-8000-000000000121'), 30, 'G20:LINE 沒發出去不影響點數');

select is(
  mark_birthday_line_result(pg_temp.gid('db150000-0000-4000-8000-000000000123', 2027), 'failed', 'HTTP 400 {"message":"Invalid reply token"}'),
  true,
  'G21:回寫 failed 成功'
);
select is(
  (select row(line_status, line_error)::text from member_birthday_bonus_grants
   where id = pg_temp.gid('db150000-0000-4000-8000-000000000123', 2027)),
  row('failed', 'HTTP 400 {"message":"Invalid reply token"}')::text,
  'G22:failed 記下 LINE 回的錯誤'
);
select is(pg_temp.bal('db150000-0000-4000-8000-000000000123'), 30, 'G23 §2.9 第 4 點:LINE 發送失敗不影響已發的點數');

-- 中斷:認領後超過 30 分鐘沒回報
update member_birthday_bonus_grants set line_attempted_at = now() - interval '31 minutes'
where id = pg_temp.gid('db150000-0000-4000-8000-000000000122', 2027);
select is((select count(*)::int from claim_birthday_line_pending(100)), 0, 'G24:中斷的那筆不會被重新認領(不自動重試)');
select is(
  (select row(line_status, line_error like '發送過程中斷%')::text from member_birthday_bonus_grants
   where id = pg_temp.gid('db150000-0000-4000-8000-000000000122', 2027)),
  row('failed', true)::text,
  'G25 §3.7 第 4 點:認領超過 30 分鐘沒回報 ⇒ 標 failed,商家看得到原因'
);

-- =========================================================================
-- I. v2.4 第 19 條(批次 5 QA 後主腦裁決)
--   ① 一位會員出錯(餘額加上去會超過 integer 上限)⇒ 只略過他,同一天另一位與 B 店會員照發
--   ② 發點後會員被下架 ⇒ 不發 LINE,標 skipped_member_removed
--   ③ 商家被平台停用 ⇒ 不發點;停用前已發點的 ⇒ 不發 LINE,標 skipped_merchant_disabled
-- =========================================================================
insert into merchants (id, group_id, name, industry_type, status) values
  ('db150000-0000-4000-8000-0000000000ac', 'db150000-0000-4000-8000-000000000011', '生日測試L店(停用)', 'in_store_beauty', 'disabled');
insert into merchant_member_settings (merchant_id, birthday_bonus_enabled, birthday_bonus_points, birthday_line_message)
values ('db150000-0000-4000-8000-0000000000ac', true, 30, '生日快樂');
insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected)
values ('db150000-0000-4000-8000-0000000000ac', 'ch-l', 'secret-l', 'token-l', true);

insert into members (id, merchant_id, name, phone, referral_code, birthday, status, line_bound, line_user_id, points_balance) values
  ('db150000-0000-4000-8000-000000000901', 'db150000-0000-4000-8000-0000000000a1', '餘額快溢位', '0915000901', 'M1015I01', '1990-08-10', 'active', false, null, 2147483640),
  ('db150000-0000-4000-8000-000000000902', 'db150000-0000-4000-8000-0000000000a1', '同天另一位', '0915000902', 'M1015I02', '1990-08-10', 'active', false, null, 0),
  ('db150000-0000-4000-8000-000000000903', 'db150000-0000-4000-8000-0000000000a2', 'B店同天', '0915000903', 'M1015I03', '1990-08-10', 'active', false, null, 0),
  ('db150000-0000-4000-8000-000000000904', 'db150000-0000-4000-8000-0000000000ac', 'L店停用中', '0915000904', 'M1015I04', '1990-08-10', 'active', true, 'U-line-904', 0),
  ('db150000-0000-4000-8000-000000000905', 'db150000-0000-4000-8000-0000000000a1', '發點後下架', '0915000905', 'M1015I05', '1990-08-20', 'active', true, 'U-line-905', 0),
  ('db150000-0000-4000-8000-000000000906', 'db150000-0000-4000-8000-0000000000ac', 'L店停用前發點', '0915000906', 'M1015I06', '1990-08-25', 'active', true, 'U-line-906', 0);

select lives_ok($$select run_birthday_bonus_grants('2027-08-10')$$,
  'I1 ①:同一天有一位會員會出錯,整批排程不中斷');
select is(
  pg_temp.gcount('db150000-0000-4000-8000-000000000901'),
  0,
  'I2 ①:出錯的那位不留發送紀錄'
);
select is(pg_temp.bal('db150000-0000-4000-8000-000000000901'), 2147483640, 'I3 ①:出錯的那位餘額完全沒動(子交易已回滾)');
select is(pg_temp.bal('db150000-0000-4000-8000-000000000902') + pg_temp.bal('db150000-0000-4000-8000-000000000903'), 80,
  'I4 ①(QA 重現情境):同店同天另一位(30)與 B 店會員(50)照發');
select is(pg_temp.gcount('db150000-0000-4000-8000-000000000904'), 0, 'I5 ③:被平台停用的商家不發生日點數');

select is(run_birthday_bonus_grants('2027-08-20'), 1, 'I6(前提):8/20 生日會員發點');
update members set status = 'removed' where id = 'db150000-0000-4000-8000-000000000905';
update merchants set status = 'active' where id = 'db150000-0000-4000-8000-0000000000ac';
select is(run_birthday_bonus_grants('2027-08-25'), 1, 'I7(前提):L 店恢復營業時 8/25 生日會員發點');
update merchants set status = 'disabled' where id = 'db150000-0000-4000-8000-0000000000ac';

select is((select count(*)::int from claim_birthday_line_pending(100)), 0,
  'I8 ②③:下架會員、停用商家的待發紀錄都不會被認領去發 LINE');
select is(
  (select row(line_status, line_error)::text from member_birthday_bonus_grants where member_id = 'db150000-0000-4000-8000-000000000905'),
  row('skipped_member_removed', '會員已下架，不發送生日 LINE 訊息(生日點數已照常發放)')::text,
  'I9 ②:發點後被下架的會員標 skipped_member_removed,原因白話'
);
select is(
  (select row(line_status, line_error)::text from member_birthday_bonus_grants where member_id = 'db150000-0000-4000-8000-000000000906'),
  row('skipped_merchant_disabled', '商家已停用，不發送生日 LINE 訊息')::text,
  'I10 ③:商家已停用 ⇒ 標 skipped_merchant_disabled,原因白話'
);
select is(pg_temp.bal('db150000-0000-4000-8000-000000000905') + pg_temp.bal('db150000-0000-4000-8000-000000000906'), 60,
  'I11 ②③:不發 LINE 不影響已發的點數');
select ok(
  (select line_error like '超過 7 天%' from member_birthday_bonus_grants
   where id = pg_temp.gid('db150000-0000-4000-8000-000000000121', 2027)),
  'I12 ④:超過 7 天不補發的失敗原因寫明「超過 7 天」'
);

-- =========================================================================
-- F. 台北時區:p_run_date = null 時用台北日期。(放在 G 之後:這一段用「真實的今天」跑,
--    可能順便發到 fixture 裡生日剛好在今天附近的會員,放後面才不會干擾 G 的認領斷言。)
--    把 session 時區設成「此刻跟台北不同日」的時區(UTC−12 或 UTC+14,任何時刻至少有一個不同日),
--    如果函式誤用 current_date,下面「台北明天」或「台北 7 天前」的會員就會被發到。
-- =========================================================================
select (now() at time zone 'Asia/Taipei')::date as tpe_today \gset
select case when (now() at time zone 'Etc/GMT+12')::date <> :'tpe_today'::date then 'Etc/GMT+12' else 'Etc/GMT-14' end as other_tz \gset
select set_config('timezone', :'other_tz', true);

insert into members (id, merchant_id, name, phone, referral_code, birthday, status) values
  ('db150000-0000-4000-8000-000000000801', 'db150000-0000-4000-8000-0000000000a8', '台北今天', '0915000801', 'M1015H01',
   make_date(1992, extract(month from :'tpe_today'::date)::int, extract(day from :'tpe_today'::date)::int), 'active'),
  ('db150000-0000-4000-8000-000000000802', 'db150000-0000-4000-8000-0000000000a8', '台北明天', '0915000802', 'M1015H02',
   make_date(1992, extract(month from :'tpe_today'::date + 1)::int, extract(day from :'tpe_today'::date + 1)::int), 'active'),
  ('db150000-0000-4000-8000-000000000803', 'db150000-0000-4000-8000-0000000000a8', '台北七天前', '0915000803', 'M1015H03',
   make_date(1992, extract(month from :'tpe_today'::date - 7)::int, extract(day from :'tpe_today'::date - 7)::int), 'active');

select ok(current_date <> :'tpe_today'::date, 'F0(前提):session 的 current_date 確實跟台北日期不同');
select lives_ok($$select run_birthday_bonus_grants()$$, 'F1:不帶日期執行(排程的呼叫方式)');
select is(
  (select anchor_date from member_birthday_bonus_grants where member_id = 'db150000-0000-4000-8000-000000000801'),
  private.birthday_anchor_date(make_date(1992, extract(month from :'tpe_today'::date)::int, extract(day from :'tpe_today'::date)::int),
                               extract(year from :'tpe_today'::date)::int),
  'F2(核心):台北今天生日的會員有發,錨定日 = 台北今天'
);
select is(
  pg_temp.gcount('db150000-0000-4000-8000-000000000802') + pg_temp.gcount('db150000-0000-4000-8000-000000000803'),
  0,
  'F3(核心):台北明天、台北 7 天前生日的會員都沒發(證明判斷用台北日期,不是 session / UTC 日期)'
);
select set_config('timezone', 'UTC', true);

-- =========================================================================
-- H. 紀錄清單 get_birthday_bonus_grants(§3.8、第 10 題)
-- =========================================================================
-- K 店灌 55 筆
insert into members (id, merchant_id, name, phone, referral_code, birthday, status)
select ('db150000-0000-4000-8000-0000000c' || lpad(i::text, 4, '0'))::uuid, 'db150000-0000-4000-8000-0000000000ab',
       'K會員' || i, '09160' || lpad(i::text, 5, '0'), 'M1015K' || lpad(i::text, 3, '0'), '1990-01-01', 'active'
from generate_series(1, 55) i;
insert into member_point_transactions (id, member_id, merchant_id, transaction_type, points_delta, balance_after)
select ('db150000-0000-4000-8000-0000000d' || lpad(i::text, 4, '0'))::uuid,
       ('db150000-0000-4000-8000-0000000c' || lpad(i::text, 4, '0'))::uuid,
       'db150000-0000-4000-8000-0000000000ab', 'birthday_bonus', 30, 30
from generate_series(1, 55) i;
insert into member_birthday_bonus_grants (merchant_id, member_id, bonus_year, anchor_date, points, point_transaction_id, member_name_snapshot, granted_at)
select 'db150000-0000-4000-8000-0000000000ab', ('db150000-0000-4000-8000-0000000c' || lpad(i::text, 4, '0'))::uuid,
       2027, '2027-01-01', 30, ('db150000-0000-4000-8000-0000000d' || lpad(i::text, 4, '0'))::uuid, 'K會員' || i,
       timestamptz '2027-01-01 00:05:00+08' + make_interval(secs => i)
from generate_series(1, 55) i;

select pg_temp.test_set_auth('db150000-0000-4000-8000-000000000006');
select is((select count(*)::int from get_birthday_bonus_grants('db150000-0000-4000-8000-0000000000ab')), 50, 'H1 §3.8:最多回傳最近 50 筆');
select is(
  (select array_agg(member_name order by granted_at desc) from (select * from get_birthday_bonus_grants('db150000-0000-4000-8000-0000000000ab') limit 2) x),
  array['K會員55', 'K會員54'],
  'H2 §3.8:新到舊排序(最新的在最前面)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('db150000-0000-4000-8000-000000000001');
select is(
  (select count(*)::int from get_birthday_bonus_grants('db150000-0000-4000-8000-0000000000a1')),
  (select count(*)::int from member_birthday_bonus_grants where merchant_id = 'db150000-0000-4000-8000-0000000000a1'),
  'H3:A 店管理員看到 A 店全部紀錄'
);
select throws_ok(
  $$select * from get_birthday_bonus_grants('db150000-0000-4000-8000-0000000000ab')$$,
  '42501', '沒有權限查看這間商家的生日紅利紀錄',
  'H4 跨商家:A 店管理員查 K 店被擋'
);
select pg_temp.test_set_auth('db150000-0000-4000-8000-000000000003');
select ok((select count(*) from get_birthday_bonus_grants('db150000-0000-4000-8000-0000000000a1')) > 0,
  'H5 第 10 題:只有 member_points 鑰匙的客服可以看');
select pg_temp.test_set_auth('db150000-0000-4000-8000-000000000004');
select ok((select count(*) from get_birthday_bonus_grants('db150000-0000-4000-8000-0000000000a1')) > 0,
  'H6 第 10 題:只有 members 鑰匙的客服可以看');
select pg_temp.test_set_auth('db150000-0000-4000-8000-000000000005');
select throws_ok(
  $$select * from get_birthday_bonus_grants('db150000-0000-4000-8000-0000000000a1')$$,
  '42501', '沒有權限查看這間商家的生日紅利紀錄',
  'H7:只有 orders 鑰匙的客服被擋'
);
select throws_ok($$select run_birthday_bonus_grants('2027-03-10')$$, '42501', null,
  'H8 §2.8:一般登入者不能觸發生日排程');
select throws_ok($$select claim_birthday_line_pending(10)$$, '42501', null,
  'H9 §3.7:一般登入者不能認領(拿不到 LINE token)');
select pg_temp.test_clear_auth();

select * from finish();
rollback;
