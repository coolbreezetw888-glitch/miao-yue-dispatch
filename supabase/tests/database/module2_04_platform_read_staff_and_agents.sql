-- 模組 2 回歸測試 ④:平台管理員讀取任一商家的「服務人員 / 客服」名單。
-- 對應 migration:20260924042000_platform_read_merchant_staff_and_agents.sql
--            規格書:.project/specs/超級管理員商家詳情強化.md 第 6.1 節(#708)
--
-- 【這份測試最重要的兩組斷言,不要因為看起來重複就刪掉】
--
-- ① 對照組(③④):同一個平台管理員身分、同一個 merchant_id,直接 `select count(*)`
--    這兩張表會拿到 **0 筆**。這釘住的是「RLS 真的擋著,所以這兩支函式不是多餘的」。
--    ⚠️ 失敗模式是「靜默的 0 筆」而不是報錯——畫面上會顯示「目前沒有服務人員」而不是
--       「沒有權限」,是最難察覺的一種 bug。如果哪天有人把 merchant_staff /
--       merchant_agents 的 SELECT 政策改成含 is_platform_admin(),這兩條會轉紅,
--       提醒他重新評估「要不要改成直接查表、把這兩支函式刪掉」。
--
-- ② LEFT JOIN 釘樁(⑨⑩):函式裡 `left join auth.users` 如果被改成 inner `join`,
--    「還沒開通登入」的服務人員(user_id is null)與「已邀請但還沒註冊」的客服
--    (user_id is null)會**整列從名單上靜默消失**——不報錯、名單就是少了人。
--    這兩條專門釘住這件事,故意各建了一位 user_id is null 的人。
--
-- 寫法比照 module2_02_platform_admin_sees_all.sql 與
-- security_audit_01_execute_privileges_and_policy_roles.sql(pg_temp.test_set_auth 切換身分)。
begin;

select plan(29);

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
-- 測試資料
--
-- 刻意讓「平台管理員」跟「商家 A」完全沒有關係(不是 merchant_admins、也不是集團管理者),
-- 因為這正是規格書第十節第 1 點警告的最容易做錯的一件事:用自己家的商家測,靠既有 RLS
-- 也讀得到,就算函式寫錯也會「通過」。
-- =========================================================================
insert into auth.users (id, email) values
  ('e2040000-0000-4000-8000-000000000001', 'pgtap-m204-platform-admin@test.local'),
  ('e2040000-0000-4000-8000-000000000002', 'pgtap-m204-merchant-admin@test.local'),
  ('e2040000-0000-4000-8000-000000000003', 'pgtap-m204-stranger@test.local'),
  ('e2040000-0000-4000-8000-000000000004', 'pgtap-m204-staff-registered@test.local'),
  ('e2040000-0000-4000-8000-000000000005', 'pgtap-m204-agent-registered@test.local');

insert into platform_admins (user_id) values ('e2040000-0000-4000-8000-000000000001');

insert into groups (id) values ('e2040000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('e2040000-0000-4000-8000-000000000021', 'e2040000-0000-4000-8000-000000000011',
   'pgtap-m204 別人家的商家', 'on_site_dispatch');

-- 商家 A 自己的管理員。平台管理員刻意「不」出現在這張表裡。
insert into merchant_admins (merchant_id, user_id) values
  ('e2040000-0000-4000-8000-000000000021', 'e2040000-0000-4000-8000-000000000002');

-- 服務人員。名字刻意用 AAA/BBB/CCC 開頭,讓「純依姓名排序」跟「先依在職狀態再依姓名排序」
-- 會得到完全不同的結果——這樣排序斷言(⑬)才真的測得出 order by 的 case 有沒有被拿掉。
insert into merchant_staff
  (id, merchant_id, user_id, name, nickname, phone, compensation_type, status, login_status, invited_login_email)
values
  -- 已移除(軟刪除)。姓名排最前面,但應該被排到最後。
  ('e2040000-0000-4000-8000-000000000031', 'e2040000-0000-4000-8000-000000000021',
   null, 'AAA已移除服務人員', null, '0900204001', 'piece_rate', 'removed', 'not_invited', null),
  -- 在職 + 已開通登入(有 user_id)。login_email 應該等於 auth.users 的登入信箱。
  ('e2040000-0000-4000-8000-000000000032', 'e2040000-0000-4000-8000-000000000021',
   'e2040000-0000-4000-8000-000000000004', 'BBB已註冊服務人員', '小B', '0900204002',
   'monthly_salary', 'active', 'active', null),
  -- ⚠️ LEFT JOIN 釘樁用:在職但 user_id is null(還沒開通登入),invited_login_email 也是 null
  --    ⇒ login_email 應該是 null,而且「這個人必須出現在結果裡」。
  ('e2040000-0000-4000-8000-000000000033', 'e2040000-0000-4000-8000-000000000021',
   null, 'CCC未開通服務人員', null, '0900204003', 'piece_rate', 'active', 'not_invited', null);

-- 客服。同樣用 AAA/BBB/CCC 讓排序斷言(⑭)有鑑別度:
-- 純姓名排序 = AAA,BBB,CCC;正確排序(active → invited → removed)= CCC,BBB,AAA。
insert into merchant_agents
  (id, merchant_id, user_id, name, nickname, phone, job_title, invited_email, status)
values
  ('e2040000-0000-4000-8000-000000000041', 'e2040000-0000-4000-8000-000000000021',
   null, 'AAA已移除客服', null, '0900204011', null,
   'pgtap-m204-agent-removed@test.local', 'removed'),
  -- ⚠️ LEFT JOIN 釘樁用:已邀請但還沒註冊(user_id is null)。
  --    客服的 invited_email 是 NOT NULL,所以 login_email 應該 fallback 成 invited_email。
  ('e2040000-0000-4000-8000-000000000042', 'e2040000-0000-4000-8000-000000000021',
   null, 'BBB邀請中客服', null, '0900204012', '值班客服',
   'pgtap-m204-agent-invited@test.local', 'invited'),
  ('e2040000-0000-4000-8000-000000000043', 'e2040000-0000-4000-8000-000000000021',
   'e2040000-0000-4000-8000-000000000005', 'CCC在職客服', '小C', '0900204013', null,
   'pgtap-m204-agent-old-invite@test.local', 'active');

-- =========================================================================
-- ①② 平台管理員讀得到「別人家商家」的完整名單(含已移除 / 邀請中的人)。
-- =========================================================================
select pg_temp.test_set_auth('e2040000-0000-4000-8000-000000000001');

select is(
  (select count(*) from public.platform_get_merchant_staff('e2040000-0000-4000-8000-000000000021'))::int,
  3,
  '①平台管理員讀得到別人家商家的全部 3 位服務人員(含 1 位已移除)'
);

select is(
  (select count(*) from public.platform_get_merchant_agents('e2040000-0000-4000-8000-000000000021'))::int,
  3,
  '②平台管理員讀得到別人家商家的全部 3 位客服(含邀請中與已移除)'
);

-- =========================================================================
-- ③④ 對照組:同一個身分直接查表 = 0 筆。這是整份測試的重點之一,不要刪。
-- =========================================================================
select is(
  (select count(*) from merchant_staff where merchant_id = 'e2040000-0000-4000-8000-000000000021')::int,
  0,
  '③對照組:同一個平台管理員身分直接查 merchant_staff 是 0 筆(RLS 真的擋著,所以 #694 不是多餘的)'
);

select is(
  (select count(*) from merchant_agents where merchant_id = 'e2040000-0000-4000-8000-000000000021')::int,
  0,
  '④對照組:同一個平台管理員身分直接查 merchant_agents 是 0 筆'
);

-- =========================================================================
-- ⑨⑩⑪⑫ 欄位正確性(LEFT JOIN 釘樁 + Email 單一真相)。
-- =========================================================================
select is(
  (select login_email from public.platform_get_merchant_staff('e2040000-0000-4000-8000-000000000021')
    where id = 'e2040000-0000-4000-8000-000000000033'),
  null,
  '⑨LEFT JOIN 釘樁(服務人員):user_id is null 的人有出現在結果裡,且 login_email 是 null'
);

-- ⚠️ ⑨ 這一條「單獨」是不夠的,實際驗證過:把函式改成 inner join 之後,那一列整個消失,
--    `select login_email … where id = …` 就回 NULL,結果仍然等於期望值 null ⇒ ⑨ 照樣 pass。
--    所以一定要搭配下面這條「數對人數」的斷言,LEFT JOIN 才真的被釘住
--    (實測:inner join 版本會讓 ⑨-2 從 2 掉到 0 而轉紅)。

select is(
  (select count(*) from public.platform_get_merchant_staff('e2040000-0000-4000-8000-000000000021')
    where user_id is null)::int,
  2,
  '⑨-2 LEFT JOIN 釘樁(服務人員):兩位 user_id is null 的人都沒有消失(改成 inner join 會掉到 0)'
);

select is(
  (select login_email from public.platform_get_merchant_agents('e2040000-0000-4000-8000-000000000021')
    where id = 'e2040000-0000-4000-8000-000000000042'),
  'pgtap-m204-agent-invited@test.local',
  '⑩LEFT JOIN 釘樁(客服):user_id is null 的邀請中客服有出現,login_email fallback 成 invited_email'
);

select is(
  (select login_email from public.platform_get_merchant_staff('e2040000-0000-4000-8000-000000000021')
    where id = 'e2040000-0000-4000-8000-000000000032'),
  'pgtap-m204-staff-registered@test.local',
  '⑪已註冊的服務人員:login_email 等於 auth.users 的登入信箱'
);

select is(
  (select login_email from public.platform_get_merchant_agents('e2040000-0000-4000-8000-000000000021')
    where id = 'e2040000-0000-4000-8000-000000000043'),
  'pgtap-m204-agent-registered@test.local',
  '⑫已註冊的客服:login_email 用 auth.users 的登入信箱,不是舊的 invited_email'
);

-- =========================================================================
-- ⑬⑭ 排序由資料庫決定(前端不再排一次)。
-- string_agg 明確帶 order by rn(函式回傳的原始列序),不依賴聚合函式的隱含順序。
-- =========================================================================
select is(
  (
    select string_agg(t.name, '|' order by t.rn)
    from (
      select name, row_number() over () as rn
      from public.platform_get_merchant_staff('e2040000-0000-4000-8000-000000000021')
    ) t
  ),
  'BBB已註冊服務人員|CCC未開通服務人員|AAA已移除服務人員',
  '⑬服務人員排序:在職(依姓名)全部排在已移除之前'
);

select is(
  (
    select string_agg(t.name, '|' order by t.rn)
    from (
      select name, row_number() over () as rn
      from public.platform_get_merchant_agents('e2040000-0000-4000-8000-000000000021')
    ) t
  ),
  'CCC在職客服|BBB邀請中客服|AAA已移除客服',
  '⑭客服排序:active → invited → removed,同組內依姓名'
);

-- =========================================================================
-- ⑮⑯⑰⑱ 邊界:不存在的 merchant_id / NULL → 回 0 筆,不 raise。
-- =========================================================================
select lives_ok(
  $$select * from public.platform_get_merchant_staff('e2040000-0000-4000-8000-0000000000ff')$$,
  '⑮不存在的 merchant_id 不會 raise(比照 get_merchant_admin_users 的既有行為)'
);

select is(
  (select count(*) from public.platform_get_merchant_staff('e2040000-0000-4000-8000-0000000000ff'))::int,
  0,
  '⑯不存在的 merchant_id 回 0 筆'
);

select is(
  (select count(*) from public.platform_get_merchant_staff(null))::int,
  0,
  '⑰p_merchant_id => null 回 0 筆,不 raise(where 恆為 NULL)'
);

select is(
  (select count(*) from public.platform_get_merchant_agents(null))::int,
  0,
  '⑱客服函式的 p_merchant_id => null 同樣回 0 筆,不 raise'
);

-- =========================================================================
-- ⑤⑥ 商家 A 自己的管理員呼叫 → 42501。
-- 這兩支函式刻意「只」給平台管理員:商家端本來就能靠既有 RLS 直接查自己家的表
-- (useMerchantStaffList / useMerchantAgentList 就是直接查),不需要這支函式,
-- 多開一個商家也能走的入口只是多一個要守的邊界(規格書第四節 (a) 最後一段)。
-- =========================================================================
select pg_temp.test_set_auth('e2040000-0000-4000-8000-000000000002');

select throws_ok(
  $$select * from public.platform_get_merchant_staff('e2040000-0000-4000-8000-000000000021')$$,
  '42501', NULL,
  '⑤商家 A 自己的管理員呼叫 platform_get_merchant_staff 被擋下(42501)'
);

select throws_ok(
  $$select * from public.platform_get_merchant_agents('e2040000-0000-4000-8000-000000000021')$$,
  '42501', NULL,
  '⑥商家 A 自己的管理員呼叫 platform_get_merchant_agents 被擋下(42501)'
);

-- =========================================================================
-- ⑦⑧ 完全無關的第三方使用者呼叫 → 42501。
-- =========================================================================
select pg_temp.test_set_auth('e2040000-0000-4000-8000-000000000003');

select throws_ok(
  $$select * from public.platform_get_merchant_staff('e2040000-0000-4000-8000-000000000021')$$,
  '42501', NULL,
  '⑦完全無關的第三方使用者呼叫 platform_get_merchant_staff 被擋下(42501)'
);

select throws_ok(
  $$select * from public.platform_get_merchant_agents('e2040000-0000-4000-8000-000000000021')$$,
  '42501', NULL,
  '⑧完全無關的第三方使用者呼叫 platform_get_merchant_agents 被擋下(42501)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑲~㉖ EXECUTE 權限收斂(#696)。
--
-- ⚠️ 為什麼一定要測這個:#694/#695 用的是 drop + create,而 PostgreSQL 對**新建**的函式
--    預設給 PUBLIC EXECUTE。security_audit_01 的「A2」記錄的就是
--    recalculate_booking_commission 被 drop + create 重寫後繼承了預設 PUBLIC EXECUTE 的
--    真實事故。目標 ACL 比照既有 platform_* 函式:
--    postgres=X | authenticated=X | service_role=X(anon 與 PUBLIC 都沒有)。
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.platform_get_merchant_staff(uuid)', 'execute'),
  '⑲anon 不能執行 platform_get_merchant_staff'
);
select ok(
  not has_function_privilege('public', 'public.platform_get_merchant_staff(uuid)', 'execute'),
  '⑳PUBLIC 虛擬角色也沒有 platform_get_merchant_staff 的執行權(drop+create 的預設值已被收掉)'
);
select ok(
  has_function_privilege('authenticated', 'public.platform_get_merchant_staff(uuid)', 'execute'),
  '㉑authenticated 保有 platform_get_merchant_staff 的執行權(前端要用)'
);
select ok(
  has_function_privilege('service_role', 'public.platform_get_merchant_staff(uuid)', 'execute'),
  '㉒service_role 保有 platform_get_merchant_staff 的執行權'
);

select ok(
  not has_function_privilege('anon', 'public.platform_get_merchant_agents(uuid)', 'execute'),
  '㉓anon 不能執行 platform_get_merchant_agents'
);
select ok(
  not has_function_privilege('public', 'public.platform_get_merchant_agents(uuid)', 'execute'),
  '㉔PUBLIC 虛擬角色也沒有 platform_get_merchant_agents 的執行權'
);
select ok(
  has_function_privilege('authenticated', 'public.platform_get_merchant_agents(uuid)', 'execute'),
  '㉕authenticated 保有 platform_get_merchant_agents 的執行權'
);
select ok(
  has_function_privilege('service_role', 'public.platform_get_merchant_agents(uuid)', 'execute'),
  '㉖service_role 保有 platform_get_merchant_agents 的執行權'
);

-- =========================================================================
-- ㉗㉘ 函式屬性:唯讀(STABLE)+ SECURITY DEFINER + 固定 search_path。
-- ㉗釘住「這兩支是唯讀函式」(規格書第五節規則 1:這兩張卡片永遠不寫入資料庫)。
-- ㉘釘住「SECURITY DEFINER 沒有被拿掉」——一旦被拿掉,失敗模式又會變成靜默的 0 筆。
-- =========================================================================
select is(
  (
    select array_agg(p.provolatile::text order by p.proname)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('platform_get_merchant_staff', 'platform_get_merchant_agents')
  ),
  array['s', 's'],
  '㉗兩支函式都是 STABLE(provolatile = ''s''),釘住「唯讀、不寫入任何資料」'
);

select ok(
  (
    select bool_and(p.prosecdef and p.proconfig @> array['search_path=public'])
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('platform_get_merchant_staff', 'platform_get_merchant_agents')
  ),
  '㉘兩支函式都是 SECURITY DEFINER 且 proconfig 含 search_path=public'
);

select * from finish();

rollback;
