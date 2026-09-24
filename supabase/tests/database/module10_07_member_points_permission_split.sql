-- 2026-09-24 使用者裁決(migration 20260924040400)的回歸測試:
--   任務 6:新增「紅利點數管理」(member_points)權限鑰匙,把點數**規則**跟點數**交易**分開授權
--
-- 【使用者裁決原文】
--   餘額總覽、手動調整、登記兌換、異動歷史 = **會員管理**(使用者確認這樣是正確的)
--   核發獎勵資格條件、點數設定(啟用開關/比例/推薦/生日) = **紅利點數管理**這個功能
--
-- 【這份測試最重要的兩條(主腦點名「這是最重要的一條」)】
--   ① 只有 members 權限的客服**不能**改點數規則
--   ② 但他**可以**做點數交易(登記兌換)
--
-- 【⚠️ 第二重要、而且最容易被實作破壞的一條(前端工程師獨立查證後回報的陷阱)】
--   merchant_member_settings 是**整列 upsert**(src/modules/members/api.ts:72 走 PostgREST,不是 RPC),
--   而 MemberSettingsPage(走 member_settings 鑰匙)在存「會員政策」時,會把那五個規則欄位
--   **原樣送一次**。所以如果把鎖實作成「payload 含規則欄位就拒絕」,只有 member_settings 權限的
--   客服會連「會員政策」都存不了——修了 A 卻壞了 B。
--   下面 ③ 那一條就是專門釘這件事的:它必須通過,否則這次的實作是錯的。
begin;

select plan(19);

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
-- Fixture:一位管理員 + 三位客服,各自只拿一把鑰匙。
--   客服 P:只有 member_points(紅利點數管理)
--   客服 S:只有 member_settings(會員系統設定)
--   客服 M:只有 members(會員管理)
-- =========================================================================
insert into auth.users (id, email) values
  ('da070000-0000-4000-8000-000000000001', 'pgtap-m1007-admin@test.local'),
  ('da070000-0000-4000-8000-000000000002', 'pgtap-m1007-agent-points@test.local'),
  ('da070000-0000-4000-8000-000000000003', 'pgtap-m1007-agent-settings@test.local'),
  ('da070000-0000-4000-8000-000000000004', 'pgtap-m1007-agent-members@test.local');

insert into groups (id) values ('da070000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type) values
  ('da070000-0000-4000-8000-000000000020', 'da070000-0000-4000-8000-000000000010', '點數權限測試店', 'in_store_beauty'),
  -- 第二間商家刻意**不**建立 merchant_member_settings 列,用來測 INSERT 面的守門。
  ('da070000-0000-4000-8000-000000000021', 'da070000-0000-4000-8000-000000000010', '點數權限測試店2(無設定列)', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('da070000-0000-4000-8000-000000000020', 'da070000-0000-4000-8000-000000000001'),
  ('da070000-0000-4000-8000-000000000021', 'da070000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('da070000-0000-4000-8000-000000000051', 'da070000-0000-4000-8000-000000000020',
   'da070000-0000-4000-8000-000000000002', '客服P(紅利點數管理)', '0900001071',
   'pgtap-m1007-agent-points@test.local', 'active'),
  ('da070000-0000-4000-8000-000000000052', 'da070000-0000-4000-8000-000000000020',
   'da070000-0000-4000-8000-000000000003', '客服S(會員系統設定)', '0900001072',
   'pgtap-m1007-agent-settings@test.local', 'active'),
  ('da070000-0000-4000-8000-000000000053', 'da070000-0000-4000-8000-000000000020',
   'da070000-0000-4000-8000-000000000004', '客服M(會員管理)', '0900001073',
   'pgtap-m1007-agent-members@test.local', 'active'),
  -- 客服 S 在第二間商家也有一筆(測 INSERT 面)
  ('da070000-0000-4000-8000-000000000054', 'da070000-0000-4000-8000-000000000021',
   'da070000-0000-4000-8000-000000000003', '客服S(第二店)', '0900001072',
   'pgtap-m1007-agent-settings@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('da070000-0000-4000-8000-000000000051', 'member_points', true),
  ('da070000-0000-4000-8000-000000000052', 'member_settings', true),
  ('da070000-0000-4000-8000-000000000053', 'members', true),
  ('da070000-0000-4000-8000-000000000054', 'member_settings', true);

insert into merchant_member_settings (
  merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points,
  reward_condition_mode, policy_enabled, policy_content
) values (
  'da070000-0000-4000-8000-000000000020', 100, 50, 30, 'none', false, '原始政策內容'
);

-- =========================================================================
-- ① private.can_manage_member_points 本身的判斷正確。
-- =========================================================================
select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000002');
select ok(
  private.can_manage_member_points('da070000-0000-4000-8000-000000000020'),
  '§1:被開通 member_points 的客服 P,can_manage_member_points 為真'
);

select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000004');
select ok(
  not private.can_manage_member_points('da070000-0000-4000-8000-000000000020'),
  '§1(核心):只有 members 權限的客服 M,can_manage_member_points 為假——「會員管理」不等於「紅利點數管理」,這是使用者這次要拆開的兩把鑰匙'
);

select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000001');
select ok(
  private.can_manage_member_points('da070000-0000-4000-8000-000000000020'),
  '§1:商家管理員永遠可以(比照既有 can_manage_members / can_manage_member_settings 的寫法)'
);

-- =========================================================================
-- ② 核心:只有 members 權限的客服 M **不能**改點數規則。
--    M 連 member_settings 也沒有,所以他連這張表的 RLS 列層級都過不了——UPDATE 會影響 0 列。
--    (RLS 的 USING 不成立時 UPDATE 是「撈不到那一列」,不會拋錯,所以這裡驗「值沒有被改動」
--     而不是驗有沒有例外。這一點很重要:前端看起來會像成功,實際上什麼都沒改。)
-- =========================================================================
select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000004');

update merchant_member_settings set points_earn_rate = 999
where merchant_id = 'da070000-0000-4000-8000-000000000020';

select pg_temp.test_clear_auth();
select is(
  (select points_earn_rate from merchant_member_settings
   where merchant_id = 'da070000-0000-4000-8000-000000000020'),
  100.00,
  '任務 6(最重要的一條):只有 members 權限的客服完全改不動 points_earn_rate(仍然是 100,不是 999)'
);

select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000004');
update merchant_member_settings set points_feature_enabled = false
where merchant_id = 'da070000-0000-4000-8000-000000000020';
select pg_temp.test_clear_auth();

select is(
  (select points_feature_enabled from merchant_member_settings
   where merchant_id = 'da070000-0000-4000-8000-000000000020'),
  true,
  '任務 6(最重要的一條):只有 members 權限的客服也改不動紅利點數啟用開關 points_feature_enabled'
);

-- =========================================================================
-- ③ ⚠️ 關鍵回歸(不能壞掉的那一半):只有 member_settings 的客服 S,存「會員政策」時
--    把五個規則欄位**原樣送一次**(整列 upsert 的必然行為)必須成功。
--    這一條如果失敗,代表鎖被寫成「payload 含規則欄位就拒絕」,那就是修了 A 壞了 B。
-- =========================================================================
select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000003');

select lives_ok(
  $$update merchant_member_settings
    set policy_enabled = true,
        policy_content = '客服S改過的政策',
        -- 以下五個規則欄位「原樣」送一次(值完全沒變),模擬整列 upsert 的真實行為
        points_earn_rate = 100,
        referral_bonus_points = 50,
        birthday_bonus_points = 30,
        points_feature_enabled = true,
        reward_condition_mode = 'none'
    where merchant_id = 'da070000-0000-4000-8000-000000000020'$$,
  '任務 6(關鍵回歸,絕對不能壞):只有 member_settings 權限的客服存「會員政策」時,即使整列 upsert 把五個規則欄位原樣送一次(值沒變),也必須成功——守門判斷的是「值真的有變動」(is distinct from),不是「payload 有沒有帶這個欄位」'
);

select pg_temp.test_clear_auth();
select is(
  (select policy_content from merchant_member_settings
   where merchant_id = 'da070000-0000-4000-8000-000000000020'),
  '客服S改過的政策',
  '任務 6:客服 S 的會員政策確實存進去了(不是被靜默擋下)'
);

-- 但 S 一旦真的去「改動」規則欄位的值,就要被擋下並給白話訊息。
select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000003');

select throws_ok(
  $$update merchant_member_settings set points_earn_rate = 200
    where merchant_id = 'da070000-0000-4000-8000-000000000020'$$,
  '42501', null,
  '任務 6(核心):只有 member_settings 權限的客服真的去改 points_earn_rate 的值 → 被擋下(42501)'
);

select throws_ok(
  $$update merchant_member_settings set reward_condition_mode = 'phone_verified'
    where merchant_id = 'da070000-0000-4000-8000-000000000020'$$,
  '42501', null,
  '任務 6(核心):「核發獎勵資格條件」(reward_condition_mode)也歸紅利點數管理,member_settings 改不動'
);

select throws_ok(
  $$update merchant_member_settings set points_feature_enabled = false
    where merchant_id = 'da070000-0000-4000-8000-000000000020'$$,
  '42501', null,
  '任務 6(核心):紅利點數啟用開關 points_feature_enabled 也歸紅利點數管理,member_settings 改不動'
);

-- INSERT 面(upsert 第一次會走 INSERT):S 在「還沒有設定列」的第二間商家直接建一列並帶規則值 → 擋下。
select throws_ok(
  $$insert into merchant_member_settings (merchant_id, points_earn_rate)
    values ('da070000-0000-4000-8000-000000000021', 50)$$,
  '42501', null,
  '任務 6(INSERT 面):只有 member_settings 權限的客服不能在「還沒有設定列」的商家 INSERT 一列並帶著非預設的規則值——否則只要繞過 UPDATE 走 INSERT 就能把規則一次填好(這正是 20260924030100 學到的教訓)'
);

-- 但只帶預設值的 INSERT 必須放行(這是 seed_default_member_settings 的路徑,擋掉會讓「建立新商家」壞掉)。
select lives_ok(
  $$insert into merchant_member_settings (merchant_id)
    values ('da070000-0000-4000-8000-000000000021')$$,
  '任務 6(INSERT 面,不能壞):只帶 merchant_id、其餘全部套用 schema 預設值的 INSERT 必須放行——public.seed_default_member_settings 建立新商家時走的就是這條路,擋掉會讓建立商家整個壞掉'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ 反面對照:有 member_points 的客服 P **可以**改規則,但**不能**改會員政策
--    (對稱保護——否則只有紅利點數權限的客服反而能去改會員政策)。
-- =========================================================================
select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000002');

select lives_ok(
  $$update merchant_member_settings
    set points_earn_rate = 200, birthday_bonus_points = 60,
        reward_condition_mode = 'phone_verified', points_feature_enabled = false
    where merchant_id = 'da070000-0000-4000-8000-000000000020'$$,
  '任務 6(反面對照):被開通 member_points 的客服 P 可以修改全部五個紅利點數規則欄位'
);

select pg_temp.test_clear_auth();
select is(
  (select points_earn_rate from merchant_member_settings
   where merchant_id = 'da070000-0000-4000-8000-000000000020'),
  200.00,
  '任務 6:客服 P 的修改確實生效(points_earn_rate 變成 200)'
);

select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000002');

select throws_ok(
  $$update merchant_member_settings set policy_content = '客服P想改政策'
    where merchant_id = 'da070000-0000-4000-8000-000000000020'$$,
  '42501', null,
  '任務 6(對稱保護):只有 member_points 權限的客服 P 不能改「會員政策」——兩組欄位兩把鑰匙,不是開了一把就全部通行'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ 核心的另一半:只有 members 權限的客服 M 仍然**可以**做點數交易(登記兌換)。
--    使用者裁決把「餘額總覽、手動調整、登記兌換、異動歷史」歸給會員管理,這一條就是在釘它。
-- =========================================================================
select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000001');
select id from create_member('da070000-0000-4000-8000-000000000020', '點數測試會員', '0955100701') \gset member_
-- 先由管理員給一點餘額(adjust_member_points 依既有規則 2.6 只限管理員,見下面 ⑥)。
select adjust_member_points(:'member_id'::uuid, 100, '測試用初始餘額');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000004');

select lives_ok(
  format($$select redeem_member_points('%s', 30, '客服M登記兌換')$$, :'member_id'),
  '任務 6(核心的另一半):只有 members 權限的客服 M **可以**登記兌換點數——使用者把「登記兌換」歸在會員管理,這次的規則鎖完全沒有影響到它'
);

select pg_temp.test_clear_auth();
select is(
  (select points_balance from members where id = :'member_id'::uuid),
  70,
  '任務 6:客服 M 的兌換真的生效(100 − 30 = 70),不是被靜默擋下'
);

-- =========================================================================
-- ⑥ 既有設計的釘子(順便講清楚一件跟任務描述有落差的事):
--    「手動調整點數」(adjust_member_points)依既有規則 2.6 **從來就只有商家管理員能做**,
--    客服不論拿哪一把鑰匙都不行(這條既有決策的理由跟 recalculate_booking_commission 相同:
--    它能無中生有增減等同「準金錢」的餘額)。前端 AGENT_PERMISSION_SECTIONS 的 members 說明
--    也早就寫著「手動調整會員點數這個敏感操作永遠只有商家管理員能做」。
--    這次一行都沒有動它,這條斷言只是把現狀釘住,避免之後有人誤以為 members 鑰匙該包含它。
-- =========================================================================
select pg_temp.test_set_auth('da070000-0000-4000-8000-000000000004');

select throws_ok(
  format($$select adjust_member_points('%s', 50, '客服M想手動調整')$$, :'member_id'),
  '42501', null,
  '既有規則 2.6(現狀釘子):手動調整點數 adjust_member_points 永遠只有商家管理員能做,客服拿 members 鑰匙也不行——這次沒有動它,但它跟任務描述「members 客服仍然可以做手動調整」有落差,已在回報中提出'
);

-- =========================================================================
-- ⑦ 任務 6 第 4 點:grant_pending_birthday_bonuses 維持 can_manage_members,確認正確。
--    它是「核發動作」(打開會員管理列表頁就自動跑),不是「設定規則」,所以 members 鑰匙就該能跑。
-- =========================================================================
select lives_ok(
  $$select grant_pending_birthday_bonuses('da070000-0000-4000-8000-000000000020')$$,
  '任務 6 第 4 點(確認維持現狀正確):grant_pending_birthday_bonuses 仍然只要 members 權限就能呼叫——它是「核發動作」(打開會員管理列表頁自動觸發),不是「設定規則」,使用者裁決歸給紅利點數管理的是「核發獎勵資格**條件**」那個設定值,不是核發這個動作'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
