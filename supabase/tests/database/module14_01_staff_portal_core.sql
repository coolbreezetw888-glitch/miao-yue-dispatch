-- 模組 14(服務人員端)— 對應規格書 .project/specs/服務人員端.md 建議實作順序 1-6
-- (資料庫地基 + 邀請登入流程)。涵蓋:1.1/1.2 schema、規則 2.1/2.2/2.4(核心必測)/2.9(核心必測,
-- 部分)/2.11、3.1-3.9/3.11/3.12/3.19。
--
-- 規則 2.9 的「真實帳號完整驗收」(用真實 JWT 從 Edge Function 全流程驗證)留給第八節建議順序
-- 第 12 步的情境測試,這裡先用 pgTAP 涵蓋「is_own_staff_row/is_merchant_staff 在 removed/
-- login_status 非 active 時一律 false」這個核心資料庫層邊界。

begin;

select plan(59);

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
-- Fixture:兩間商家(A/B,測跨商家隔離)。
-- 商家 A:管理員 admin、客服 agent(無任何 section_key)、服務人員 X(按件計酬,已完成登入)、
-- Y(月薪制,已完成登入,但故意也 granted staff_availability_self_manage 用來驗證規則 2.2
-- 「即使開通也被計酬類型擋下」)、Z(status=removed,已完成登入,規則 2.9 回歸)、
-- W(status=active 但 login_status=invited,規則 2.9 回歸)、New(尚未邀請登入,3.9/3.11/3.12 流程用)。
-- 商家 B:管理員 admin2,只用來驗證服務人員 X 跨商家看不到。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1400000-0000-4000-8000-000000000001', 'pgtap-m14-admin-a@test.local'),
  ('e1400000-0000-4000-8000-000000000002', 'pgtap-m14-staff-x@test.local'),
  ('e1400000-0000-4000-8000-000000000003', 'pgtap-m14-staff-y@test.local'),
  ('e1400000-0000-4000-8000-000000000004', 'pgtap-m14-agent@test.local'),
  ('e1400000-0000-4000-8000-000000000005', 'pgtap-m14-staff-z@test.local'),
  ('e1400000-0000-4000-8000-000000000006', 'pgtap-m14-staff-w@test.local'),
  ('e1400000-0000-4000-8000-000000000007', 'pgtap-m14-admin-b@test.local'),
  ('e1400000-0000-4000-8000-000000000008', 'pgtap-m14-staff-new@test.local'),
  ('e1400000-0000-4000-8000-000000000009', 'pgtap-m14-staff-new2@test.local');

insert into groups (id) values
  ('e1400000-0000-4000-8000-000000000011'),
  ('e1400000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000011', '服務人員端測試A店', 'on_site_dispatch'),
  ('e1400000-0000-4000-8000-000000000022', 'e1400000-0000-4000-8000-000000000012', '服務人員端測試B店', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id) values
  ('e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000001'),
  ('e1400000-0000-4000-8000-000000000022', 'e1400000-0000-4000-8000-000000000007');

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at) values
  ('e1400000-0000-4000-8000-000000000031', 'e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000002', '服務人員X(按件)', 'piece_rate', 'active', 'active', now()),
  ('e1400000-0000-4000-8000-000000000032', 'e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000003', '服務人員Y(月薪)', 'monthly_salary', 'active', 'active', now()),
  ('e1400000-0000-4000-8000-000000000033', 'e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000005', '服務人員Z(已移除)', 'piece_rate', 'removed', 'active', now()),
  ('e1400000-0000-4000-8000-000000000034', 'e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000006', '服務人員W(邀請中)', 'piece_rate', 'active', 'invited', null),
  ('e1400000-0000-4000-8000-000000000035', 'e1400000-0000-4000-8000-000000000021', null, '服務人員New(未邀請)', 'piece_rate', 'active', 'not_invited', null);

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('e1400000-0000-4000-8000-000000000041', 'e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000004', '客服-無授權', 'pgtap-m14-agent@test.local', 'active', now());

insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('e1400000-0000-4000-8000-000000000031', 'staff_calendar_view', true),
  ('e1400000-0000-4000-8000-000000000031', 'staff_availability_self_manage', true),
  ('e1400000-0000-4000-8000-000000000031', 'staff_payroll_view', true),
  ('e1400000-0000-4000-8000-000000000031', 'staff_profile_edit', true),
  ('e1400000-0000-4000-8000-000000000032', 'staff_availability_self_manage', true);

-- =========================================================================
-- 1.1 schema:CHECK 約束、既有資料回填、login_status 與 status 各自獨立(規則 2.1)。
-- =========================================================================
select is(
  (select login_status from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  'not_invited',
  '1.1:新增服務人員時 login_status 預設 not_invited'
);

select throws_ok(
  $$update merchant_staff set login_status = 'bogus' where id = 'e1400000-0000-4000-8000-000000000035'$$,
  '23514',
  NULL,
  '1.1:login_status 的 CHECK 約束擋下非法值'
);

select is(
  (select count(*)::int from merchant_staff where merchant_id = 'e1400000-0000-4000-8000-000000000021' and status = 'active'),
  4,
  '1.1:既有 status=active 篩選查詢不受新欄位影響,筆數正確(X/Y/W/New,不含已移除的 Z)'
);

-- 規則 2.1:改 status 不影響 login_status,改 login_status 不影響 status(用一筆獨立資料驗證,
-- 避免影響其他測試段落用到的 fixture)。
update merchant_staff set status = 'removed' where id = 'e1400000-0000-4000-8000-000000000034';
select is(
  (select login_status from merchant_staff where id = 'e1400000-0000-4000-8000-000000000034'),
  'invited',
  '規則 2.1:status 改變不影響 login_status'
);
update merchant_staff set status = 'active' where id = 'e1400000-0000-4000-8000-000000000034';

update merchant_staff set login_status = 'active' where id = 'e1400000-0000-4000-8000-000000000035';
select is(
  (select status from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  'active',
  '規則 2.1:login_status 改變不影響 status'
);
update merchant_staff set login_status = 'not_invited' where id = 'e1400000-0000-4000-8000-000000000035';

-- =========================================================================
-- 1.2 schema:merchant_staff_permissions 的 unique(staff_id, section_key)、granted 預設 true。
-- =========================================================================
select throws_ok(
  $$insert into merchant_staff_permissions (staff_id, section_key, granted) values ('e1400000-0000-4000-8000-000000000031', 'staff_calendar_view', false)$$,
  '23505',
  NULL,
  '1.2:unique(staff_id, section_key) 擋下重複列'
);

insert into merchant_staff_permissions (staff_id, section_key) values
  ('e1400000-0000-4000-8000-000000000033', 'staff_calendar_view');
select is(
  (select granted from merchant_staff_permissions where staff_id = 'e1400000-0000-4000-8000-000000000033' and section_key = 'staff_calendar_view'),
  true,
  '1.2:granted 欄位預設 true(判斷 1)'
);

-- =========================================================================
-- 3.5/2.4/2.9(核心必測):private.is_own_staff_row。
-- =========================================================================
select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000002'); -- 服務人員 X

select ok(
  private.is_own_staff_row('e1400000-0000-4000-8000-000000000031'),
  '3.5:服務人員 X 對自己的 staff_id 回傳 true'
);

select ok(
  not private.is_own_staff_row('e1400000-0000-4000-8000-000000000032'),
  '規則 2.4(核心必測):服務人員 X 傳入服務人員 Y 的 staff_id,is_own_staff_row 回傳 false'
);

select ok(
  not private.has_own_staff_permission('e1400000-0000-4000-8000-000000000032', 'staff_calendar_view'),
  '規則 2.4(核心必測):服務人員 X 傳入 Y 的 staff_id 呼叫 has_own_staff_permission 回傳 false'
);

select ok(
  not private.can_self_manage_availability('e1400000-0000-4000-8000-000000000032'),
  '規則 2.4(核心必測):服務人員 X 傳入 Y 的 staff_id 呼叫 can_self_manage_availability 回傳 false'
);

select ok(
  not private.can_view_staff_own_payroll('e1400000-0000-4000-8000-000000000032'),
  '規則 2.4(核心必測):服務人員 X 傳入 Y 的 staff_id 呼叫 can_view_staff_own_payroll 回傳 false'
);

-- 3.6/3.7/3.8 正向路徑(服務人員 X 本人,四項權限皆已開通,按件計酬)。
select ok(
  private.has_own_staff_permission('e1400000-0000-4000-8000-000000000031', 'staff_calendar_view'),
  '3.6:服務人員 X 已開通 staff_calendar_view 時回傳 true'
);
select ok(
  private.can_self_manage_availability('e1400000-0000-4000-8000-000000000031'),
  '3.7:按件計酬 + 已開通權限,can_self_manage_availability 回傳 true'
);
select ok(
  private.can_view_staff_own_payroll('e1400000-0000-4000-8000-000000000031'),
  '3.8:服務人員 X 已開通 staff_payroll_view 時回傳 true'
);

-- 3.1/3.2:merchants_select 疊加。服務人員 X 看得到 A 店,看不到 B 店。
select is(
  (select count(*)::int from merchants where id = 'e1400000-0000-4000-8000-000000000021'),
  1,
  '3.2:服務人員 X 透過 merchants_select 疊加後看得到自己服務的 A 店'
);
select ok(
  private.is_merchant_staff('e1400000-0000-4000-8000-000000000021'),
  '3.1:is_merchant_staff 對 A 店回傳 true'
);
select is(
  (select count(*)::int from merchants where id = 'e1400000-0000-4000-8000-000000000022'),
  0,
  '3.2:服務人員 X 看不到沒有服務過的 B 店'
);
select ok(
  not private.is_merchant_staff('e1400000-0000-4000-8000-000000000022'),
  '3.1:is_merchant_staff 對沒有服務過的 B 店回傳 false'
);

-- 3.3:merchant_staff_select 疊加。服務人員 X 讀得到自己,讀不到 Y(沒有任何管理員/客服權限)。
select is(
  (select count(*)::int from merchant_staff where id = 'e1400000-0000-4000-8000-000000000031'),
  1,
  '3.3:服務人員 X 讀得到自己那一筆'
);
select is(
  (select count(*)::int from merchant_staff where id = 'e1400000-0000-4000-8000-000000000032'),
  0,
  '3.3:服務人員 X 讀不到同商家其他服務人員(Y)的資料'
);

-- 3.19:merchant_staff_permissions RLS。服務人員 X 讀得到自己 4 筆,讀不到 Y 的權限列。
select is(
  (select count(*)::int from merchant_staff_permissions where staff_id = 'e1400000-0000-4000-8000-000000000031'),
  4,
  '3.19:服務人員 X 讀得到自己的 4 筆權限設定'
);
select is(
  (select count(*)::int from merchant_staff_permissions where staff_id = 'e1400000-0000-4000-8000-000000000032'),
  0,
  '3.19:服務人員 X 讀不到服務人員 Y 的權限設定'
);
select throws_ok(
  $$insert into merchant_staff_permissions (staff_id, section_key, granted) values ('e1400000-0000-4000-8000-000000000031', 'staff_profile_edit', false)$$,
  NULL,
  NULL,
  '3.19:merchant_staff_permissions 沒有開放給 authenticated 直接 INSERT(一律透過 SECURITY DEFINER 函式)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 規則 2.2:月薪制服務人員即使被開通 staff_availability_self_manage 也被擋下。
-- =========================================================================
select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000003'); -- 服務人員 Y(月薪制)

select ok(
  private.has_own_staff_permission('e1400000-0000-4000-8000-000000000032', 'staff_availability_self_manage'),
  '規則 2.2 前提:服務人員 Y 確實已被開通 staff_availability_self_manage 這把鑰匙'
);
select ok(
  not private.can_self_manage_availability('e1400000-0000-4000-8000-000000000032'),
  '規則 2.2(核心):月薪制服務人員即使 granted=true,can_self_manage_availability 仍回傳 false'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 規則 2.9(核心必測):status=removed 或 login_status<>active 時,一律被擋下。
-- =========================================================================
select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000005'); -- 服務人員 Z(已移除)

select ok(
  not private.is_own_staff_row('e1400000-0000-4000-8000-000000000033'),
  '規則 2.9(核心必測):status=removed 的服務人員,is_own_staff_row 回傳 false'
);
select ok(
  not private.is_merchant_staff('e1400000-0000-4000-8000-000000000021'),
  '規則 2.9(核心必測):status=removed 的服務人員,is_merchant_staff 回傳 false'
);
select is(
  (select count(*)::int from merchants where id = 'e1400000-0000-4000-8000-000000000021'),
  0,
  '規則 2.9(核心必測):status=removed 後,同一組登入身份完全看不到這間商家'
);
select is(
  (select count(*)::int from merchant_staff where id = 'e1400000-0000-4000-8000-000000000033'),
  1,
  '規則 2.9 邊界情況:被移除的服務人員仍能讀到自己「已被移除」的那一筆(誠實狀態,比照客服規則 2.9)'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000006'); -- 服務人員 W(status=active 但 login_status=invited)

select ok(
  not private.is_own_staff_row('e1400000-0000-4000-8000-000000000034'),
  '規則 2.9(核心必測):login_status=invited(尚未完成設定密碼)的服務人員,is_own_staff_row 回傳 false'
);
select ok(
  not private.is_merchant_staff('e1400000-0000-4000-8000-000000000021'),
  '規則 2.9(核心必測):login_status=invited 的服務人員,is_merchant_staff 回傳 false'
);
select is(
  (select count(*)::int from merchants where id = 'e1400000-0000-4000-8000-000000000021'),
  0,
  '規則 2.9(核心必測):login_status 尚未 active 前,完全看不到商家'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 規則 2.11:邀請/權限設定只有商家管理員能做,客服(即使有其他權限)一律被擋下。
-- =========================================================================
select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000004'); -- 客服(無任何 section_key)

select throws_ok(
  $$select set_staff_permission('e1400000-0000-4000-8000-000000000031', 'staff_calendar_view', false)$$,
  '42501',
  NULL,
  '規則 2.11:客服呼叫 set_staff_permission 被擋下'
);

select pg_temp.test_clear_auth();

-- 3.4:商家管理員可以成功設定/更新服務人員的權限開關。
select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000001'); -- 商家管理員

select lives_ok(
  $$select set_staff_permission('e1400000-0000-4000-8000-000000000031', 'staff_calendar_view', false)$$,
  '3.4:商家管理員可以成功關閉服務人員的某項自助功能'
);
select is(
  (select granted from merchant_staff_permissions where staff_id = 'e1400000-0000-4000-8000-000000000031' and section_key = 'staff_calendar_view'),
  false,
  '3.4:set_staff_permission 呼叫後,資料庫真的更新成指定的 granted 值'
);
-- 還原,避免影響本檔案後續(理論上沒有,但保持乾淨)。
select lives_ok(
  $$select set_staff_permission('e1400000-0000-4000-8000-000000000031', 'staff_calendar_view', true)$$,
  '3.4:重新開啟後恢復 granted=true'
);

-- 管理員仍能看到整間商家(不含移除)所有服務人員(overlay 疊加後既有行為不受影響)。
select is(
  (select count(*)::int from merchant_staff where merchant_id = 'e1400000-0000-4000-8000-000000000021'),
  5,
  '3.3:既有商家管理員行為不受疊加影響,仍能看到本商家全部服務人員(含已移除的 Z)'
);
select is(
  (select count(*)::int from merchants where id = 'e1400000-0000-4000-8000-000000000021'),
  1,
  '3.2:既有商家管理員行為不受疊加影響,仍能看到自己的商家'
);
select is(
  (select count(*)::int from merchant_staff_permissions where staff_id = 'e1400000-0000-4000-8000-000000000032'),
  1,
  '3.19:商家管理員可以讀到底下任一服務人員的權限設定'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 3.9/3.11/3.12:邀請登入流程(record_invited_staff_login → seed_default_staff_permissions →
-- mark_staff_login_active_if_self)。這幾支只給 service_role/本人呼叫,用 postgres 超級使用者
-- 身份模擬 service_role(has_function_privilege 另外驗證真正的授權對象)。
-- =========================================================================

-- 權限邊界:authenticated/anon 不能呼叫這兩支只給 service_role 的函式。
select ok(
  not has_function_privilege('authenticated', 'public.record_invited_staff_login(uuid, uuid, text, text)', 'execute'),
  '3.11:authenticated 角色不能呼叫 record_invited_staff_login'
);
select ok(
  not has_function_privilege('anon', 'public.record_invited_staff_login(uuid, uuid, text, text)', 'execute'),
  '3.11:anon 角色不能呼叫 record_invited_staff_login'
);
select ok(
  not has_function_privilege('authenticated', 'public.seed_default_staff_permissions(uuid)', 'execute'),
  '3.9:authenticated 角色不能直接呼叫 seed_default_staff_permissions'
);

-- 走「查無帳號,邀請信」分支:login_status 進到 invited。
select lives_ok(
  $$select record_invited_staff_login('e1400000-0000-4000-8000-000000000035', 'e1400000-0000-4000-8000-000000000008', 'invited-x@test.local', 'invited')$$,
  '3.11:record_invited_staff_login(邀請信分支)成功執行'
);
select is(
  (select login_status from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  'invited',
  '3.11:寫入後 login_status 變成 invited'
);
select is(
  (select invited_login_email from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  'invited-x@test.local',
  '3.11:invited_login_email 正確寫入'
);
select ok(
  (select login_invited_at is not null from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  '3.11:login_invited_at 正確寫入'
);
select ok(
  (select login_activated_at is null from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  '3.11:走邀請信分支時 login_activated_at 維持 null(還沒設定密碼)'
);
select is(
  (select count(*)::int from merchant_staff_permissions where staff_id = 'e1400000-0000-4000-8000-000000000035'),
  4,
  '3.9:record_invited_staff_login 成功後緊接著種入 4 筆預設權限'
);
select is(
  (select count(*)::int from merchant_staff_permissions where staff_id = 'e1400000-0000-4000-8000-000000000035' and granted = true),
  4,
  '3.9:四筆預設權限皆為 granted=true(判斷 1)'
);

-- 3.12:服務人員本人完成設定密碼後,轉場頁呼叫 mark_staff_login_active_if_self()。
select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000008'); -- New 這位服務人員本人

select lives_ok(
  $$select mark_staff_login_active_if_self()$$,
  '3.12:服務人員本人呼叫 mark_staff_login_active_if_self 成功'
);

select pg_temp.test_clear_auth();

select is(
  (select login_status from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  'active',
  '3.12:呼叫後 login_status 變成 active'
);
select ok(
  (select login_activated_at is not null from merchant_staff where id = 'e1400000-0000-4000-8000-000000000035'),
  '3.12:呼叫後 login_activated_at 正確寫入'
);

-- 3.12 邊界:只能改自己的紀錄,不會誤改到其他 invited 中的服務人員。
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, invited_login_email, login_invited_at)
values ('e1400000-0000-4000-8000-000000000036', 'e1400000-0000-4000-8000-000000000021', 'e1400000-0000-4000-8000-000000000009', '服務人員New2(邀請中)', 'piece_rate', 'active', 'invited', 'invited-new2@test.local', now());

select pg_temp.test_set_auth('e1400000-0000-4000-8000-000000000008'); -- New(已經是 active),不應該影響 New2
select lives_ok(
  $$select mark_staff_login_active_if_self()$$,
  '3.12 邊界:已經是 active 的人重複呼叫不報錯(update 條件 login_status=invited 找不到列,靜默無事)'
);
select pg_temp.test_clear_auth();

select is(
  (select login_status from merchant_staff where id = 'e1400000-0000-4000-8000-000000000036'),
  'invited',
  '3.12 邊界:不會誤改到別人(New2)的 login_status'
);

-- 走「已有既有帳號」分支:login_status 直接是 active,login_activated_at 一併寫入。
select lives_ok(
  $$select record_invited_staff_login('e1400000-0000-4000-8000-000000000036', 'e1400000-0000-4000-8000-000000000009', 'invited-new2@test.local', 'active')$$,
  '3.11:record_invited_staff_login(既有帳號分支)成功執行'
);
select is(
  (select login_status from merchant_staff where id = 'e1400000-0000-4000-8000-000000000036'),
  'active',
  '3.11:既有帳號分支直接寫入 login_status=active'
);
select ok(
  (select login_activated_at is not null from merchant_staff where id = 'e1400000-0000-4000-8000-000000000036'),
  '3.11:既有帳號分支一併寫入 login_activated_at'
);

select throws_ok(
  $$select record_invited_staff_login('e1400000-0000-4000-8000-000000000036', 'e1400000-0000-4000-8000-000000000009', 'x@test.local', 'not_invited')$$,
  NULL,
  NULL,
  '3.11:傳入不合法的 p_login_status(not_invited)被擋下'
);

select * from finish();

rollback;
